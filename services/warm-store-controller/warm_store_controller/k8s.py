"""Thin k8s access for the warm-store controller: pool PVCs and PVs, per-conversation Sandboxes, the clean-shutdown marker, warm Jobs and the leader-election Lease."""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from collections.abc import Iterator
from dataclasses import dataclass

from kubernetes import client, config

from .logging_config import format_error
from .allocate import (
    ANN_LAST_USED,
    LBL_WARM_STORE,
    Node,
    PendingSandbox,
    PoolPv,
)
from .reconcile import PoolPvc, SandboxRef, WarmJobStatus

logger = logging.getLogger("k8s")

# The upstream agent-sandbox Sandbox CR.
SANDBOX_GROUP = "agents.x-k8s.io"
SANDBOX_VERSION = "v1beta1"
SANDBOX_PLURAL = "sandboxes"

# Pool PVC labels; LBL_WARM_STORE and ANN_LAST_USED are shared with the PV layer via allocate.py.
LBL_POOL_STATE = "scooter.io/pool-state"   # warming|ready|claimed|retiring
LBL_CLAIMED_BY = "scooter.io/claimed-by"   # conv id when claimed
LBL_WARM_PVC = "scooter.io/warm-pvc"       # on a warm Job: the PVC name it warms
POOL_SELECTOR = LBL_POOL_STATE             # any PVC carrying a pool-state is a pool PVC

# The clean-shutdown marker the sandbox writes into the overlay upper on graceful stop.
CLEAN_MARKER_PATH = "/nix/.scooter-rw/.clean-shutdown"

_core: client.CoreV1Api | None = None
_custom: client.CustomObjectsApi | None = None
_batch: client.BatchV1Api | None = None
_coord: client.CoordinationV1Api | None = None


def _apis() -> tuple[client.CoreV1Api, client.CustomObjectsApi, client.BatchV1Api, client.CoordinationV1Api]:
    global _core, _custom, _batch, _coord
    if _core is None:
        try:
            config.load_incluster_config()
        except config.ConfigException:
            config.load_kube_config()
        _core = client.CoreV1Api()
        _custom = client.CustomObjectsApi()
        _batch = client.BatchV1Api()
        _coord = client.CoordinationV1Api()
    assert _core is not None and _custom is not None and _batch is not None and _coord is not None
    return _core, _custom, _batch, _coord


@dataclass
class ControllerK8s:
    """Imperative k8s ops the reconcile loop uses.

    :param namespace: the k8s namespace all operations target.
    :param warm_job_image: sandbox image the warm Job boots.
    :param warm_golden_expr: the golden Nix expression the warm Job builds into the overlay.
    :param overlay_storage: size of each pool PVC.
    :param runtime_class: a cgroup-delegating RuntimeClass for the warm Job's systemd pod, matching the per-conversation sandboxRuntimeClass (empty means the cluster default).
    :param pool_storage_class: the pool StorageClass, which must have reclaimPolicy Retain or nothing is ever recycled.
    """

    namespace: str
    warm_job_image: str = ""
    warm_golden_expr: str = ""
    overlay_storage: str = "20Gi"
    runtime_class: str = ""
    pool_storage_class: str = ""

    # --- observe -----------------------------------------------------------
    def list_pool_pvcs(self) -> list[PoolPvc]:
        """Every pool PVC as a PoolPvc, with `bound_to_pod` from a live-pod scan and `warm_job_status` from the linked warm Job."""
        core, _, _, _ = _apis()
        bound = self._claim_names_bound_to_live_pods()
        warm_status = self._warm_job_status_by_pvc()
        out: list[PoolPvc] = []
        for pvc in core.list_namespaced_persistent_volume_claim(
            self.namespace, label_selector=POOL_SELECTOR
        ).items:
            labels = pvc.metadata.labels or {}
            annotations = pvc.metadata.annotations or {}
            name = pvc.metadata.name
            out.append(
                PoolPvc(
                    name=name,
                    image_tag=labels.get(LBL_WARM_STORE, ""),
                    state=labels.get(LBL_POOL_STATE, ""),
                    claimed_by=labels.get(LBL_CLAIMED_BY),
                    last_used=annotations.get(ANN_LAST_USED),
                    bound_to_pod=name in bound,
                    warm_job_status=warm_status.get(name),
                    terminating=pvc.metadata.deletion_timestamp is not None,
                )
            )
        return out

    def _warm_job_status_by_pvc(self) -> dict[str, WarmJobStatus]:
        """PVC name to its warm Job's state via the LBL_WARM_PVC link; a PVC whose Job was GC'd is absent and reads as still warming."""
        _, _, batch, _ = _apis()
        out: dict[str, WarmJobStatus] = {}
        for job in batch.list_namespaced_job(self.namespace, label_selector="app=warm-store-seed").items:
            pvc = (job.metadata.labels or {}).get(LBL_WARM_PVC)
            if not pvc:
                continue
            st = job.status
            if st is not None and (st.succeeded or 0) >= 1:
                out[pvc] = "succeeded"
            elif st is not None and (st.failed or 0) >= 1:
                out[pvc] = "failed"
            else:
                out[pvc] = "running"
        return out

    def list_sandboxes(self) -> list[SandboxRef]:
        """Per-conversation Sandboxes as SandboxRefs, resolving the unmount marker only for suspended ones."""
        _, custom, _, _ = _apis()
        resp = custom.list_namespaced_custom_object(
            SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL
        )
        out: list[SandboxRef] = []
        for cr in resp.get("items", []):
            conv_id, image_tag = self._sandbox_identity(cr)
            suspended = (cr.get("spec", {}).get("operatingMode", "Running") != "Running")
            marker = self.read_unmount_marker(conv_id) if suspended else "clean"
            out.append(
                SandboxRef(conv_id=conv_id, image_tag=image_tag, suspended=suspended, unmount_marker=marker)
            )
        return out

    def read_unmount_marker(self, conv_id: str) -> str:
        """Resolve the clean-shutdown marker on a suspended conversation's claimed PVC as "clean", "unclean" (definitively absent) or "unknown", where a failure to read, a missing claim or a terminating PVC is unknown rather than evidence of dirtiness."""
        pvc = self._pool_pvc_claimed_by(conv_id)
        if pvc is None:
            return "unknown"
        if pvc.metadata.deletion_timestamp is not None:
            # A check Job against a terminating claim could never schedule.
            logger.info(
                "clean-marker skipped: claim is terminating",
                extra={"conversation_id": conv_id, "pvc": pvc.metadata.name},
            )
            return "unknown"
        try:
            return self._marker_result(pvc.metadata.name)
        except client.ApiException as e:
            logger.warning(
                "clean-marker read failed; treating as UNKNOWN (backing off, not deleting)",
                extra={"conversation_id": conv_id, "pvc": pvc.metadata.name, "error": format_error(e)},
            )
            return "unknown"

    # --- apply -------------------------------------------------------------
    def warm_new(self, image_tag: str) -> None:
        """Create a fresh `warming` PVC and launch a warm Job that boots the sandbox image, builds warm_golden_expr into the overlay upper and powers off."""
        core, _, batch, _ = _apis()
        pvc_name = self.create_pool_pvc(
            image_tag,
            generate_name=f"warm-store-{_tag_slug(image_tag)}-",
            extra_labels={LBL_POOL_STATE: "warming"},
        )
        batch.create_namespaced_job(self.namespace, self._warm_job_manifest(pvc_name, image_tag))

    def _warm_job_manifest(self, pvc_name: str, image_tag: str) -> client.V1Job:
        """The warm Job: an initContainer writes the .warm-request the image's seed unit is gated on, then the sandbox container boots, warms and powers off."""
        upper = "/nix/.scooter-rw"
        expr = self.warm_golden_expr
        init = client.V1Container(
            name="warm-request",
            image="busybox:1.36",
            command=["sh", "-c", f'printf %s "$GOLDEN_EXPR" > {upper}/.warm-request'],
            env=[client.V1EnvVar(name="GOLDEN_EXPR", value=expr)],
            volume_mounts=[client.V1VolumeMount(name="scooter-rw", mount_path=upper)],
        )
        sandbox = client.V1Container(
            name="sandbox",
            image=self.warm_job_image,
            # systemd PID 1 needs SYS_ADMIN for the overlay mount, as in the per-conversation sandbox.
            security_context=client.V1SecurityContext(
                capabilities=client.V1Capabilities(add=["SYS_ADMIN"])
            ),
            env=[client.V1EnvVar(name="SCOOTER_IMAGE_TAG", value=image_tag)],
            volume_mounts=[
                client.V1VolumeMount(name="scooter-rw", mount_path=upper),
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
                        init_containers=[init],
                        containers=[sandbox],
                        volumes=[
                            client.V1Volume(
                                name="scooter-rw",
                                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                                    claim_name=pvc_name
                                ),
                            ),
                            client.V1Volume(name="run", empty_dir=client.V1EmptyDirVolumeSource(medium="Memory")),
                            client.V1Volume(name="tmp", empty_dir=client.V1EmptyDirVolumeSource(medium="Memory")),
                        ],
                    ),
                ),
            ),
        )

    def relabel(self, pvc: str, state: str, labels: dict[str, str | None]) -> None:
        """Patch a pool PVC's pool-state and extra labels, where a None value removes the label."""
        core, _, _, _ = _apis()
        patch_labels: dict[str, str | None] = {LBL_POOL_STATE: state, **labels}
        core.patch_namespaced_persistent_volume_claim(
            pvc, self.namespace, {"metadata": {"labels": patch_labels}}
        )

    def delete_pvc(self, pvc: str) -> None:
        """Delete a pool PVC, tolerating a 404."""
        core, _, _, _ = _apis()
        try:
            core.delete_namespaced_persistent_volume_claim(pvc, self.namespace)
        except client.ApiException as e:
            if e.status != 404:
                raise

    # --- PV placement: pre-create the PVC the vct will adopt, pre-bound via claimRef.

    def iter_pool_pvs(self) -> Iterator[PoolPv]:
        """Pool PVs, most-recently-used first, with nodeAffinity passed through verbatim."""
        core, _, _, _ = _apis()
        items = list(core.list_persistent_volume(label_selector=LBL_WARM_STORE).items)
        items.sort(key=self._recency_key, reverse=True)
        for pv in items:
            meta, spec = pv.metadata, pv.spec
            labels = meta.labels or {}
            annotations = meta.annotations or {}
            terms: list[dict] = []
            na = getattr(spec, "node_affinity", None)
            required = getattr(na, "required", None) if na else None
            for term in (getattr(required, "node_selector_terms", None) or []):
                terms.append(
                    {
                        "matchExpressions": [
                            {"key": e.key, "operator": e.operator, "values": list(e.values or [])}
                            for e in (term.match_expressions or [])
                        ],
                        "matchFields": [
                            {"key": e.key, "operator": e.operator, "values": list(e.values or [])}
                            for e in (getattr(term, "match_fields", None) or [])
                        ],
                    }
                )
            yield PoolPv(
                name=meta.name,
                image_tag=labels.get(LBL_WARM_STORE, ""),
                phase=(pv.status.phase if pv.status else "") or "",
                node_selector_terms=terms,
                last_used=annotations.get(ANN_LAST_USED),
                claim_ref=(spec.claim_ref.name if spec.claim_ref else None),
                terminating=meta.deletion_timestamp is not None,
            )

    @staticmethod
    def _recency_key(pv) -> str:
        """When this PV was last handed out: the last-used annotation, else the phase-transition time, else "" (which sorts oldest)."""
        annotations = (pv.metadata.annotations or {})
        stamp = annotations.get(ANN_LAST_USED)
        if stamp:
            return stamp
        transition = getattr(pv.status, "last_phase_transition_time", None) if pv.status else None
        if transition is None:
            return ""
        # A datetime is normalised to the rfc3339 string form so it sorts with the rest.
        return transition if isinstance(transition, str) else transition.strftime("%Y-%m-%dT%H:%M:%SZ")

    def list_pool_pvs(self) -> list[PoolPv]:
        """Materialised iter_pool_pvs."""
        return list(self.iter_pool_pvs())

    def list_nodes(self) -> list[Node]:
        """Nodes reduced to the labels a PV's nodeAffinity can match on, with cordoned ones flagged unschedulable."""
        core, _, _, _ = _apis()
        out: list[Node] = []
        for n in core.list_node().items:
            unschedulable = bool(getattr(n.spec, "unschedulable", False))
            out.append(
                Node(name=n.metadata.name, labels=n.metadata.labels or {}, schedulable=not unschedulable)
            )
        return out

    def list_pending_uppers(self) -> list[PendingSandbox]:
        """Running Sandboxes whose `scooter-rw` PVC does not exist yet."""
        core, custom, _, _ = _apis()
        existing = {
            pvc.metadata.name
            for pvc in core.list_namespaced_persistent_volume_claim(self.namespace).items
        }
        resp = custom.list_namespaced_custom_object(
            SANDBOX_GROUP, SANDBOX_VERSION, self.namespace, SANDBOX_PLURAL
        )
        out: list[PendingSandbox] = []
        for cr in resp.get("items", []):
            if (cr.get("spec", {}).get("operatingMode", "Running") != "Running"):
                continue
            name, image_tag = self._sandbox_identity(cr)
            vcts = cr.get("spec", {}).get("volumeClaimTemplates") or []
            if not any((v.get("metadata") or {}).get("name") == "scooter-rw" for v in vcts):
                continue
            pvc_name = f"scooter-rw-{name}"
            if pvc_name in existing:
                continue
            out.append(PendingSandbox(sandbox=name, image_tag=image_tag, pvc_name=pvc_name))
        return out

    def reserve_pv(self, pv: str, pvc_name: str, sandbox: str) -> None:
        """Pre-bind `pv` to `pvc_name` via claimRef first, then create that PVC so the vct adopts it."""
        core, _, _, _ = _apis()
        core.patch_persistent_volume(
            pv,
            {
                "spec": {"claimRef": {"namespace": self.namespace, "name": pvc_name}},
                "metadata": {
                    "annotations": {ANN_LAST_USED: _now_rfc3339()}
                },
            },
        )
        # On a 409 the claimRef above still decides which PV the existing PVC gets.
        try:
            core.create_namespaced_persistent_volume_claim(
                self.namespace,
                client.V1PersistentVolumeClaim(
                    metadata=client.V1ObjectMeta(
                        name=pvc_name,
                        labels={LBL_WARM_STORE: self._pv_tag(pv)},
                    ),
                    spec=client.V1PersistentVolumeClaimSpec(
                        access_modes=["ReadWriteOnce"],
                        resources=client.V1ResourceRequirements(requests={"storage": self.overlay_storage}),
                        storage_class_name=self.pool_storage_class,
                        volume_name=pv,
                    ),
                ),
            )
        except client.ApiException as e:
            if e.status != 409:
                raise

    def create_pool_pvc(
        self,
        image_tag: str,
        *,
        name: str | None = None,
        generate_name: str | None = None,
        extra_labels: dict[str, str] | None = None,
    ) -> str:
        """The one way a volume enters the pool: a PVC on the pool StorageClass with the warm-store label, returning its name (adopt_bound_pvs labels the PV once it exists)."""
        core, _, _, _ = _apis()
        meta = client.V1ObjectMeta(
            labels={LBL_WARM_STORE: image_tag, **(extra_labels or {})},
            **({"name": name} if name else {"generate_name": generate_name or ""}),
        )
        pvc = core.create_namespaced_persistent_volume_claim(
            self.namespace,
            client.V1PersistentVolumeClaim(
                metadata=meta,
                spec=client.V1PersistentVolumeClaimSpec(
                    access_modes=["ReadWriteOnce"],
                    resources=client.V1ResourceRequirements(requests={"storage": self.overlay_storage}),
                    storage_class_name=self.pool_storage_class,
                ),
            ),
        )
        return pvc.metadata.name

    def adopt_bound_pvs(self, pvcs: list[str]) -> None:
        """Label the PVs behind pool PVCs so iter_pool_pvs can see them, since a dynamically-provisioned PV inherits no labels and only exists once bound."""
        core, _, _, _ = _apis()
        for pvc_name in pvcs:
            try:
                pvc = core.read_namespaced_persistent_volume_claim(pvc_name, self.namespace)
                pv_name = pvc.spec.volume_name
                tag = (pvc.metadata.labels or {}).get(LBL_WARM_STORE)
                if not pv_name or not tag:
                    continue
                pv = core.read_persistent_volume(pv_name)
                if (pv.metadata.labels or {}).get(LBL_WARM_STORE) == tag:
                    continue
                core.patch_persistent_volume(pv_name, {"metadata": {"labels": {LBL_WARM_STORE: tag}}})
                logger.info("adopted a PV into the pool", extra={"pv": pv_name, "pvc": pvc_name})
            except client.ApiException as e:
                if e.status != 404:
                    raise

    def grow_pool(self, pvc_name: str, image_tag: str) -> None:
        """Add a pool volume under the name the sandbox's vct will adopt."""
        try:
            self.create_pool_pvc(image_tag, name=pvc_name)
        except client.ApiException as e:
            if e.status != 409:  # the vct beat us to the name
                raise

    def release_pv(self, pv: str) -> None:
        """Return `pv` to the pool by clearing spec.claimRef, since k8s will not rebind a Released PV that still names its late PVC."""
        core, _, _, _ = _apis()
        try:
            core.patch_persistent_volume(pv, {"spec": {"claimRef": None}})
        except client.ApiException as e:
            if e.status != 404:
                raise

    def _pv_tag(self, pv: str) -> str:
        """The image tag a PV was warmed against, read back for the PVC's label."""
        core, _, _, _ = _apis()
        try:
            obj = core.read_persistent_volume(pv)
        except client.ApiException:
            return ""
        return (obj.metadata.labels or {}).get(LBL_WARM_STORE, "")

    # --- helpers -----------------------------------------------------------
    def _claim_names_bound_to_live_pods(self) -> set[str]:
        """PVC names currently mounted by a non-terminal pod."""
        core, _, _, _ = _apis()
        bound: set[str] = set()
        for pod in core.list_namespaced_pod(self.namespace).items:
            if pod.status and pod.status.phase in ("Succeeded", "Failed"):
                continue
            for vol in pod.spec.volumes or []:
                if vol.persistent_volume_claim is not None:
                    bound.add(vol.persistent_volume_claim.claim_name)
        return bound

    def _pool_pvc_claimed_by(self, conv_id: str):
        """The pool PVC object claimed by this conversation, or None."""
        core, _, _, _ = _apis()
        sel = f"{LBL_POOL_STATE}=claimed,{LBL_CLAIMED_BY}={conv_id}"
        items = core.list_namespaced_persistent_volume_claim(self.namespace, label_selector=sel).items
        return items[0] if items else None

    def _marker_result(self, pvc: str) -> str:
        """Test for CLEAN_MARKER_PATH on `pvc` via a short-lived read-only reader Job: Completed is "clean", Failed is "unclean", and a timeout is "unknown"."""
        _, _, batch, _ = _apis()
        job = client.V1Job(
            metadata=client.V1ObjectMeta(generate_name="warm-marker-check-"),
            spec=client.V1JobSpec(
                backoff_limit=0,
                ttl_seconds_after_finished=60,
                active_deadline_seconds=60,
                template=client.V1PodTemplateSpec(
                    spec=client.V1PodSpec(
                        restart_policy="Never",
                        containers=[
                            client.V1Container(
                                name="check",
                                image="busybox:1.36",
                                command=["sh", "-c", f"test -f {CLEAN_MARKER_PATH}"],
                                volume_mounts=[
                                    client.V1VolumeMount(name="up", mount_path="/nix/.scooter-rw", read_only=True)
                                ],
                            )
                        ],
                        volumes=[
                            client.V1Volume(
                                name="up",
                                persistent_volume_claim=client.V1PersistentVolumeClaimVolumeSource(
                                    claim_name=pvc, read_only=True
                                ),
                            )
                        ],
                    )
                ),
            ),
        )
        created = batch.create_namespaced_job(self.namespace, job)
        return {"succeeded": "clean", "failed": "unclean"}.get(
            _job_result(created.metadata.name, self.namespace), "unknown"
        )

    def _sandbox_identity(self, cr: dict) -> tuple[str, str]:
        """(conv_id, image_tag) for a Sandbox CR: its name and the tag of its container image."""
        name = cr["metadata"]["name"]
        image = ""
        try:
            image = cr["spec"]["podTemplate"]["spec"]["containers"][0]["image"]
        except (KeyError, IndexError, TypeError):
            pass
        return name, _tag_of(image)


# --- module-level pure helpers ---------------------------------------------

def _now_rfc3339() -> str:
    """UTC rfc3339, for the last-used stamp."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _tag_of(image_ref: str) -> str:
    """The tag portion of an OCI ref, matching the kubenix `lib.last (splitString ":" ...)` split, or "" when untagged."""
    if not image_ref:
        return ""
    # After stripping any digest, the last ':' segment is the tag unless it contains a '/' (a registry port).
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


def _job_result(name: str, namespace: str, timeout_s: float = 60.0, clock=time) -> str:
    """Poll a Job to "succeeded", "failed" or, when it reaches neither within the deadline, "unknown"."""
    _, _, batch, _ = _apis()
    deadline = clock.time() + timeout_s
    while clock.time() < deadline:
        st = batch.read_namespaced_job_status(name, namespace).status
        if st is not None and (st.succeeded or 0) >= 1:
            return "succeeded"
        if st is not None and (st.failed or 0) >= 1:
            return "failed"
        clock.sleep(1.5)
    return "unknown"
