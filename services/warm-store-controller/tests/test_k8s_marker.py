"""Reading a marker-check Job: only the command's own failure means dirty."""

from warm_store_controller.k8s import marker_status


def job(succeeded=0, failed=0, reason=None):
    conds = [{"type": "Failed", "reason": reason}] if reason else []
    return {"status": {"succeeded": succeeded, "failed": failed, "conditions": conds}}


def test_marker_status():
    assert marker_status(job(succeeded=1)) == "clean"
    assert marker_status(job(failed=1, reason="BackoffLimitExceeded")) == "dirty"
    assert marker_status(job(failed=1, reason="DeadlineExceeded")) == "unknown"
    assert marker_status(job()) == "running"
    assert marker_status({"status": None}) == "running"
