"""Thin k8s access for the warm-store controller: pool PVs, overlay and warm PVCs,
Sandboxes, warm and marker-check Jobs, nodes and TokenReview."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from kubernetes import client, config

from .allocate import (
    ANN_LAST_SANDBOX,
    ANN_RELEASED_AT,
    ANN_RESERVED_AT,
    ANN_SHUTDOWN,
    LBL_POOL,
    LBL_WARM_STORE,
    Node,
    PoolPv,
)
from .janitor import (
    LBL_MARKER_PVC,
    LBL_WARM_SEED,
    WARM_PVC_PREFIX,
    MarkerStatus,
    Pvc,
    Sandbox,
    WarmJob,
)

logger = logging.getLogger("k8s")

SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

LBL_WARM_PVC = "scooter.io/warm-pvc"   # on a warm Job: the PVC it warms
HOSTNAME = "kubernetes.io/hostname"
UPPER = "/nix/.scooter-rw"
CLEAN_MARKER_PATH = f"{UPPER}/.clean-shutdown"

_core: client.CoreV1Api | None = None
_custom: client.CustomObjectsApi | None = None
_batch: client.BatchV1Api | None = None
_coord: client.CoordinationV1Api | None = None
_auth: client.AuthenticationV1Api | None = None


def _apis() -> tuple[client.CoreV1Api, client.CustomObjectsApi, client.BatchV1Api, client.CoordinationV1Api]:
    global _core, _custom, _batch, _coord, _auth
    if _core is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _custom = client.CustomObjectsApi()
        _batch = client.BatchV1Api()
        _coord = client.CoordinationV1Api()
        _auth = client.AuthenticationV1Api()
    assert _core is not None and _custom is not None and _batch is not None and _coord is not None
    return _core, _custom, _batch, _coord


def _auth_api() -> client.AuthenticationV1Api:
    _apis()
    assert _auth is not None
    return _auth


@dataclass
class ControllerK8s:
    """Imperative k8s ops for the pass and for /reserve.

    :param namespace: where Sandboxes, PVCs and Jobs live.
    :param pool_storage_class: the Retain StorageClass pool PVs are provisioned on.
    :param warm_job_image: sandbox image the warm Job boots.
    :param warm_golden_expr: the Nix expression the warm Job builds into the upper.
    :param overlay_storage: size of each warm PVC.
    :param runtime_class: RuntimeClass for the warm Job, matching the sandboxes.
    :param user_namespace: run the warm Job in its own user namespace, matching the sandboxes.
    """

    namespace: str
    pool_storage_class: str = ""
    warm_job_image: str = ""
    warm_golden_expr: str = ""
    overlay_storage: str = "20Gi"
    runtime_class: str = ""
    user_namespace: bool = False

    # --- observe -------------------------------------------------------------------
    def list_pvs(self) -> list:
        """Every PV, raw: pool PVs plus the workspace PVs that pin sandboxes to nodes."""
        core, _, _, _ = _apis()
        return list(core.list_persistent_volume().items)

    def pool_pvs(self, raw: list) -> list[PoolPv]:
        """The PVs on the pool StorageClass."""
        return [to_pool_pv(pv) for pv in raw if (pv.spec.storage_class_name or "") == self.pool_storage_class]

    def list_pvcs(self) -> dict[str, Pvc]:
        core, _, _, _ = _apis()
        out: dict[str, Pvc] = {}
        for pvc in core.list_namespaced_persistent_volume_claim(self.namespace).items:
            out[pvc.metadata.name] = to_pvc(pvc)
        return out

    def read_pvc(self, name: str) -> Pvc | None:
        core, _, _, _ = _apis()
        try:
            return to_pvc(core.read_namespaced_persistent_volume_claim(name, self.namespace))
        except client.ApiException as e:
            if e.status == 404:
                return None
            raise

    def list_sandboxes(self) -> dict[str, Sandbox]:
        _, custom, _, _ = _apis()
        resp = custom.list_namespaced_custom_object(SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL)
        out: dict[str, Sandbox] = {}
        for cr in resp.get("items", []):
            sb = to_sandbox(cr)
            out[sb.name] = sb
        return out

    def read_sandbox(self, name: str) -> Sandbox | None:
        _, custom, _, _ = _apis()
        try:
            cr = custom.get_namespaced_custom_object(SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL, name)
        except client.ApiException as e:
            if e.status == 404:
                return None
            raise
        return to_sandbox(cr)

    def mounted_claims(self) -> set[str]:
        """PVC names a non-terminal pod mounts."""
        core, _, _, _ = _apis()
        out: set[str] = set()
        for pod in core.list_namespaced_pod(self.namespace).items:
            if pod.status and pod.status.phase in ("Succeeded", "Failed"):
                continue
            for vol in pod.spec.volumes or []:
                if vol.persistent_volume_claim is not None:
                    out.add(vol.persistent_volume_claim.claim_name)
        return out

    def list_nodes(self) -> list[Node]:
        core, _, _, _ = _apis()
        return [
            Node(name=n.metadata.name, labels=n.metadata.labels or {}, schedulable=not bool(n.spec.unschedulable))
            for n in core.list_node().items
        ]

    def warm_jobs(self) -> tuple[dict[str, WarmJob], list[float]]:
        """Warm Jobs by the PVC they warm, and the durations of the ones that succeeded."""
        _, _, batch, _ = _apis()
        jobs: dict[str, WarmJob] = {}
        seconds: list[float] = []
        for job in batch.list_namespaced_job(self.namespace, label_selector="app=warm-store-seed").items:
            pvc = (job.metadata.labels or {}).get(LBL_WARM_PVC)
            if not pvc:
                continue
            st = job.status
            node = ((job.spec.template.spec.node_selector or {}) if job.spec else {}).get(HOSTNAME)
            if st is not None and (st.succeeded or 0) >= 1:
                jobs[pvc] = WarmJob("succeeded", node)
                if st.start_time and st.completion_time:
                    seconds.append((st.completion_time - st.start_time).total_seconds())
            elif st is not None and (st.failed or 0) >= 1:
                jobs[pvc] = WarmJob("failed", node)
            else:
                jobs[pvc] = WarmJob("running", node)
        return jobs, seconds

    def marker_jobs(self) -> dict[str, MarkerStatus]:
        """Marker-check results by the PVC they read."""
        _, _, batch, _ = _apis()
        out: dict[str, MarkerStatus] = {}
        for job in batch.list_namespaced_job(self.namespace, label_selector=LBL_MARKER_PVC).items:
            pvc = (job.metadata.labels or {}).get(LBL_MARKER_PVC)
            if pvc and job.metadata.deletion_timestamp is None:
                out[pvc] = marker_status(job)
        return out

    # --- PV writes, each a resourceVersion CAS ---
    def _patch_pv(self, pv: PoolPv, body: dict) -> None:
        core, _, _, _ = _apis()
        body.setdefault("metadata", {})["resourceVersion"] = pv.resource_version
        core.patch_persistent_volume(pv.name, body)

    def reserve(self, pv: PoolPv, pvc_name: str) -> None:
        """Pre-bind `pv` to the overlay PVC the sandbox's vct will create."""
        self._patch_pv(pv, {
            "metadata": {"annotations": {ANN_RESERVED_AT: now_rfc3339()}},
            "spec": {"claimRef": {
                "apiVersion": "v1", "kind": "PersistentVolumeClaim",
                "namespace": self.namespace, "name": pvc_name,
            }},
        })

    def label_bound(self, pv: PoolPv, tag: str, last_sandbox: str | None, drop_shutdown: bool) -> None:
        ann: dict[str, str | None] = {}
        if last_sandbox:
            ann[ANN_LAST_SANDBOX] = last_sandbox
        if drop_shutdown:
            ann[ANN_SHUTDOWN] = None
        self._patch_pv(pv, {"metadata": {"labels": {LBL_WARM_STORE: tag, LBL_POOL: None}, "annotations": ann}})

    def recycle(self, pv: PoolPv, pool: str) -> None:
        """Clear claimRef so the PV is Available again, and stamp when it joined `pool`."""
        self._patch_pv(pv, {
            "metadata": {
                "labels": {LBL_POOL: pool},
                "annotations": {ANN_RELEASED_AT: now_rfc3339(), ANN_SHUTDOWN: None, ANN_RESERVED_AT: None},
            },
            "spec": {"claimRef": None},
        })

    def clear_reservation(self, pv: PoolPv) -> None:
        self._patch_pv(pv, {"metadata": {"annotations": {ANN_RESERVED_AT: None}}, "spec": {"claimRef": None}})

    def retire(self, pv: PoolPv) -> None:
        """Bind to a claim that never exists, under Delete, so the provisioner wipes the disk."""
        self._patch_pv(pv, {
            "metadata": {"labels": {LBL_POOL: None}},
            "spec": {
                "persistentVolumeReclaimPolicy": "Delete",
                "claimRef": {
                    "apiVersion": "v1", "kind": "PersistentVolumeClaim", "namespace": self.namespace,
                    "name": f"retired-{pv.name}", "uid": str(uuid.uuid4()),
                },
            },
        })

    def retire_bound(self, pv_name: str) -> None:
        """Wipe a bound PV once its PVC is deleted."""
        core, _, _, _ = _apis()
        core.patch_persistent_volume(pv_name, {
            "metadata": {"labels": {LBL_POOL: None}},
            "spec": {"persistentVolumeReclaimPolicy": "Delete"},
        })

    def mark_clean(self, pv_name: str) -> None:
        core, _, _, _ = _apis()
        core.patch_persistent_volume(pv_name, {"metadata": {"annotations": {ANN_SHUTDOWN: "clean"}}})

    # --- PVCs and Jobs ------------------------------------------------------------------
    def delete_pvc(self, name: str) -> None:
        core, _, _, _ = _apis()
        try:
            core.delete_namespaced_persistent_volume_claim(name, self.namespace)
        except client.ApiException as e:
            if e.status != 404:
                raise

    def set_pvc_label(self, name: str, key: str, value: str | None) -> None:
        core, _, _, _ = _apis()
        try:
            core.patch_namespaced_persistent_volume_claim(name, self.namespace, {"metadata": {"labels": {key: value}}})
        except client.ApiException as e:
            if e.status != 404:
                raise

    def delete_marker_jobs(self, pvc: str) -> None:
        _, _, batch, _ = _apis()
        batch.delete_collection_namespaced_job(
            self.namespace, label_selector=f"{LBL_MARKER_PVC}={pvc}", propagation_policy="Background"
        )

    def delete_warm_jobs(self, pvc: str) -> None:
        _, _, batch, _ = _apis()
        batch.delete_collection_namespaced_job(
            self.namespace, label_selector=f"{LBL_WARM_PVC}={pvc}", propagation_policy="Background"
        )

    def start_marker_check(self, pvc: str) -> None:
        """A read-only Job that succeeds iff the clean-shutdown marker is on the upper."""
        _, _, batch, _ = _apis()
        batch.create_namespaced_job(self.namespace, self.marker_job_manifest(pvc))

    def marker_job_manifest(self, pvc: str) -> client.V1Job:
        return client.V1Job(
            metadata=client.V1ObjectMeta(generate_name="warm-marker-check-", labels={LBL_MARKER_PVC: pvc}),
            spec=client.V1JobSpec(
                backoff_limit=0,
                ttl_seconds_after_finished=300,
                active_deadline_seconds=120,
                template=client.V1PodTemplateSpec(
                    spec=client.V1PodSpec(
                        restart_policy="Never",
                        containers=[client.V1Container(
                            name="check",
                            image="busybox:1.36",
                            command=["sh", "-c", f"test -f {CLEAN_MARKER_PATH}"],
                            volume_mounts=[client.V1VolumeMount(name="up", mount_path=UPPER, read_only=True)],
                        )],
                        volumes=[client.V1Volume(
                            name="up",
                            persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=pvc, read_only=True),
                        )],
                    )
                ),
            ),
        )

    def start_warm(self, image_tag: str, node: str | None) -> str:
        """A warm PVC plus the Job that boots the sandbox image against it."""
        core, _, batch, _ = _apis()
        pvc = core.create_namespaced_persistent_volume_claim(
            self.namespace,
            client.V1PersistentVolumeClaim(
                metadata=client.V1ObjectMeta(
                    generate_name=f"{WARM_PVC_PREFIX}{_tag_slug(image_tag)}-",
                    labels={LBL_WARM_STORE: image_tag, LBL_WARM_SEED: "true"},
                ),
                spec=client.V1PersistentVolumeClaimSpec(
                    access_modes=["ReadWriteOnce"],
                    resources=client.V1ResourceRequirements(requests={"storage": self.overlay_storage}),
                    storage_class_name=self.pool_storage_class,
                ),
            ),
        )
        name = pvc.metadata.name
        batch.create_namespaced_job(self.namespace, self._warm_job_manifest(name, image_tag, node))
        return name

    def _warm_job_manifest(self, pvc_name: str, image_tag: str, node: str | None = None) -> client.V1Job:
        """The warm Job: an initContainer writes .warm-request, then the sandbox boots, warms and powers off."""
        init = client.V1Container(
            name="warm-request",
            image="busybox:1.36",
            command=["sh", "-c", f'printf %s "$GOLDEN_EXPR" > {UPPER}/.warm-request'],
            env=[client.V1EnvVar(name="GOLDEN_EXPR", value=self.warm_golden_expr)],
            volume_mounts=[client.V1VolumeMount(name="scooter-rw", mount_path=UPPER)],
        )
        sandbox = client.V1Container(
            name="sandbox",
            image=self.warm_job_image,
            # systemd PID 1 needs SYS_ADMIN for the overlay mount.
            security_context=client.V1SecurityContext(
                capabilities=client.V1Capabilities(add=["SYS_ADMIN"]),
                # Unmasked only under a user namespace; the apiserver rejects it otherwise.
                proc_mount="Unmasked" if self.user_namespace else None,
            ),
            env=[client.V1EnvVar(name="SCOOTER_IMAGE_TAG", value=image_tag)],
            volume_mounts=[
                client.V1VolumeMount(name="scooter-rw", mount_path=UPPER),
                client.V1VolumeMount(name="run", mount_path="/run"),
                client.V1VolumeMount(name="tmp", mount_path="/tmp"),
            ],
        )
        return client.V1Job(
            metadata=client.V1ObjectMeta(
                generate_name=f"warm-{_tag_slug(image_tag)}-",
                labels={LBL_WARM_STORE: image_tag, LBL_WARM_PVC: pvc_name, "app": "warm-store-seed"},
            ),
            spec=client.V1JobSpec(
                backoff_limit=2,
                active_deadline_seconds=1800,
                ttl_seconds_after_finished=300,
                template=client.V1PodTemplateSpec(
                    metadata=client.V1ObjectMeta(labels={"app": "warm-store-seed"}),
                    spec=client.V1PodSpec(
                        restart_policy="OnFailure",
                        runtime_class_name=self.runtime_class or None,
                        # Pod root and its SYS_ADMIN then apply only inside the pod's user namespace.
                        host_users=False if self.user_namespace else None,
                        # The PV is provisioned where this pod lands.
                        node_selector={HOSTNAME: node} if node else None,
                        init_containers=[init],
                        containers=[sandbox],
                        volumes=[
                            client.V1Volume(
                                name="scooter-rw",
                                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(claim_name=pvc_name),
                            ),
                            client.V1Volume(name="run", empty_dir=client.V1EmptyDirVolumeSource(medium="Memory")),
                            client.V1Volume(name="tmp", empty_dir=client.V1EmptyDirVolumeSource(medium="Memory")),
                        ],
                    ),
                ),
            ),
        )

    # --- auth ------------------------------------------------------------------------------
    def review_token(self, token: str, audience: str) -> str | None:
        """The authenticated username for `token` scoped to `audience`, else None."""
        review = _auth_api().create_token_review(
            client.V1TokenReview(spec=client.V1TokenReviewSpec(token=token, audiences=[audience]))
        )
        st = review.status
        if not st or not st.authenticated or audience not in (st.audiences or []):
            return None
        return st.user.username if st.user else None


# --- conversions --------------------------------------------------------------------

def to_pool_pv(pv) -> PoolPv:
    meta, spec = pv.metadata, pv.spec
    labels = meta.labels or {}
    ann = meta.annotations or {}
    return PoolPv(
        name=meta.name,
        image_tag=labels.get(LBL_WARM_STORE, ""),
        phase=(pv.status.phase if pv.status else "") or "",
        pool=labels.get(LBL_POOL),
        node_selector_terms=node_terms(pv),
        claim_ref=spec.claim_ref.name if spec.claim_ref else None,
        claim_uid=spec.claim_ref.uid if spec.claim_ref else None,
        last_sandbox=ann.get(ANN_LAST_SANDBOX),
        released_at=ann.get(ANN_RELEASED_AT),
        reserved_at=ann.get(ANN_RESERVED_AT),
        shutdown_clean=ann.get(ANN_SHUTDOWN) == "clean",
        reclaim_policy=spec.persistent_volume_reclaim_policy or "Retain",
        terminating=meta.deletion_timestamp is not None,
        resource_version=meta.resource_version or "",
    )


def node_terms(pv) -> list[dict]:
    """A PV's required nodeSelectorTerms as plain dicts."""
    na = getattr(pv.spec, "node_affinity", None)
    required = getattr(na, "required", None) if na else None
    out: list[dict] = []
    for term in getattr(required, "node_selector_terms", None) or []:
        out.append({
            "matchExpressions": [
                {"key": e.key, "operator": e.operator, "values": list(e.values or [])}
                for e in (term.match_expressions or [])
            ],
            "matchFields": [
                {"key": e.key, "operator": e.operator, "values": list(e.values or [])}
                for e in (getattr(term, "match_fields", None) or [])
            ],
        })
    return out


def to_pvc(pvc) -> Pvc:
    meta = pvc.metadata
    created = meta.creation_timestamp
    return Pvc(
        name=meta.name,
        phase=(pvc.status.phase if pvc.status else "") or "",
        volume_name=pvc.spec.volume_name or None,
        storage_class=pvc.spec.storage_class_name,
        labels=dict(meta.labels or {}),
        terminating=meta.deletion_timestamp is not None,
        created_at=created.timestamp() if created else 0.0,
    )


def to_sandbox(cr: dict) -> Sandbox:
    meta = cr.get("metadata", {})
    spec = cr.get("spec", {})
    image = ""
    try:
        image = spec["podTemplate"]["spec"]["containers"][0]["image"]
    except (KeyError, IndexError, TypeError):
        pass
    created = meta.get("creationTimestamp")
    if isinstance(created, datetime):
        created_at = created.timestamp()
    elif created:
        created_at = datetime.fromisoformat(str(created).replace("Z", "+00:00")).timestamp()
    else:
        created_at = 0.0
    return Sandbox(
        name=meta.get("name", ""),
        tag=_tag_of(image),
        suspended=spec.get("operatingMode", "Running") != "Running",
        created_at=created_at,
    )


def marker_status(job) -> MarkerStatus:
    """Succeeded is clean; a failed check command is dirty; anything else is unknown."""
    st = job.status
    if st is None:
        return "running"
    if (st.succeeded or 0) >= 1:
        return "clean"
    if (st.failed or 0) >= 1:
        reasons = {c.reason for c in (st.conditions or []) if c.type == "Failed"}
        # Only the command's own failure proves the marker is absent.
        return "dirty" if "BackoffLimitExceeded" in reasons else "unknown"
    return "running"


def now_rfc3339() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tag_of(image_ref: str) -> str:
    """The tag of an OCI ref, matching the kubenix split, or "" when untagged."""
    if not image_ref:
        return ""
    ref = image_ref.split("@", 1)[0]
    last = ref.rsplit(":", 1)
    if len(last) == 2 and "/" not in last[1]:
        return last[1]
    return ""


def _tag_slug(image_tag: str) -> str:
    """A DNS-1123-safe slug of an image tag for PVC and Job names."""
    out = []
    for ch in image_tag.lower():
        out.append(ch if (ch.isalnum() or ch == "-") else "-")
    slug = "".join(out).strip("-")[:40].strip("-")
    return slug or "untagged"
