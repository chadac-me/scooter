"""Tier 1: the warm Job's pod security posture, rendered without a cluster."""

from warm_store_controller.k8s import ControllerK8s


def _render(**kw):
    k8s = ControllerK8s(namespace="ns", warm_job_image="img:tag", **kw)
    pod = k8s._warm_job_manifest("pool-1", "tag").spec.template.spec
    return pod, pod.containers[0].security_context


def test_default_keeps_host_users_and_masked_proc():
    pod, ctx = _render()
    assert pod.host_users is None
    assert ctx.proc_mount is None
    assert ctx.capabilities.add == ["SYS_ADMIN"]


def test_user_namespace_sets_host_users_false_and_unmasked_proc():
    pod, ctx = _render(user_namespace=True, runtime_class="crun")
    assert pod.host_users is False
    assert ctx.proc_mount == "Unmasked"
    assert ctx.capabilities.add == ["SYS_ADMIN"]
    assert pod.runtime_class_name == "crun"
