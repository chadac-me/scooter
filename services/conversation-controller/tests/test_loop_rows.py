"""reconcile_once with the conversations row as the source of truth, on a real Postgres."""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from conversation_controller.loop import AutoscaleState, autoscale_once, reap_orphans, reconcile_once
from conversation_controller.reconcile import Pod, SandboxRef
from conversation_controller.rows import ConversationRows

from .test_loop import FakeK8s, _Cfg, _reset_zombie_state  # noqa: F401  (autouse reset)

MIGRATIONS = Path(
    os.environ.get("AGENT_HOST_MIGRATIONS")
    or Path(__file__).resolve().parents[3] / "lib/sql/agent_host/migrations"
)


@pytest.fixture
def pg(tmp_path):
    for b in ("initdb", "pg_ctl"):
        assert shutil.which(b), f"{b} not on PATH: these tests need a real Postgres"
    data = tmp_path / "data"
    # Unix socket paths cap at 107 bytes; pytest's tmp_path overflows it.
    sock = tempfile.mkdtemp(prefix="pg")
    subprocess.run(["initdb", "-D", data, "-U", "postgres", "--auth=trust", "--no-sync"],
                   check=True, capture_output=True)
    subprocess.run(["pg_ctl", "-D", data, "-w", "-l", tmp_path / "log",
                    "-o", f"-k {sock} -c listen_addresses= -c fsync=off", "start"],
                   check=True, capture_output=True)
    dsn = f"host={sock} user=postgres dbname=postgres"
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn:
        for f in sorted(MIGRATIONS.glob("*.sql")):
            conn.execute(f.read_text())
    yield dsn
    subprocess.run(["pg_ctl", "-D", data, "-m", "immediate", "stop"], capture_output=True)
    shutil.rmtree(sock, ignore_errors=True)


def _sql(dsn, q, *args):
    import psycopg

    with psycopg.connect(dsn, autocommit=True) as conn:
        cur = conn.execute(q, args)
        return cur.fetchall() if cur.description else None


def _row(dsn, conv_id, host=None, gen=0, phase=None, sandbox_ref=None):
    _sql(dsn, "INSERT INTO conversations (id, thread_id, title, created_at, last_activity_at,"
              " host_pod, host_generation, phase, sandbox_ref) VALUES (%s, %s, '', 0, 0, %s, %s, %s, %s)",
         conv_id, conv_id, host, gen, phase, sandbox_ref)


def _placement(dsn, conv_id):
    return _sql(dsn, "SELECT host_pod, host_generation, phase FROM conversations WHERE id = %s", conv_id)[0]


PODS = [Pod("pod-a", True, ip="10.0.0.1"), Pod("pod-b", True, ip="10.0.0.2")]


def test_a_router_claim_is_kept(pg):
    _row(pg, "c1", host="pod-b", gen=1, phase="Assigned")
    k = FakeK8s(PODS, [])
    assert ("c1", "noop") in reconcile_once(k, cap=10, rows=ConversationRows(pg))
    assert _placement(pg, "c1") == ("pod-b", 1, "Assigned")


def test_an_unassigned_row_is_assigned_in_the_row(pg):
    _row(pg, "c1")
    k = FakeK8s(PODS, [])
    reconcile_once(k, cap=10, rows=ConversationRows(pg))
    host, gen, phase = _placement(pg, "c1")
    assert host in ("pod-a", "pod-b") and gen == 1 and phase == "Assigned"


def test_losing_to_a_router_claim_leaves_the_winner(pg, monkeypatch):
    _row(pg, "c1")
    rows = ConversationRows(pg)
    snapshot = rows.list_states(set(), set())
    # The router claims between the controller's read and its write.
    _sql(pg, "UPDATE conversations SET host_pod = 'pod-b', host_generation = 1 WHERE id = 'c1'")
    monkeypatch.setattr(rows, "list_states", lambda *_: snapshot)
    k = FakeK8s([Pod("pod-a", True, ip="10.0.0.1")], [])
    assert ("c1", "assign-lost") in reconcile_once(k, cap=10, rows=rows)
    assert _placement(pg, "c1")[:2] == ("pod-b", 1)
    assert k.revives == []


def test_a_claimed_revive_gets_a_tick_to_resume_its_sandbox(pg):
    # A claimed revive whose sandbox has not resumed yet.
    _row(pg, "c1", host="pod-a", gen=4, phase="Assigned", sandbox_ref="conv-c1")
    sb = SandboxRef("conv-c1", age_seconds=999, operating_mode="Suspended")
    k = FakeK8s(PODS, [], sandboxes=[sb])
    assert ("c1", "drift-grace") in reconcile_once(k, cap=10, rows=ConversationRows(pg))
    assert _placement(pg, "c1") == ("pod-a", 4, "Assigned")


def test_drift_that_persists_is_still_repaired(pg, monkeypatch):
    import conversation_controller.loop as loop_mod

    now = [0.0]
    monkeypatch.setattr(loop_mod, "_now", lambda: now[0])
    _row(pg, "c1", host="pod-a", gen=4, phase="Assigned", sandbox_ref="conv-c1")
    sb = SandboxRef("conv-c1", age_seconds=999, operating_mode="Suspended")
    k = FakeK8s(PODS, [], sandboxes=[sb])
    rows = ConversationRows(pg)
    reconcile_once(k, cap=10, rows=rows)
    # pod-a is Ready, so the drift may be a revive until the grace runs out.
    assert ("c1", "drift-revive-grace") in reconcile_once(k, cap=10, rows=rows)
    assert _placement(pg, "c1") == ("pod-a", 4, "Assigned")
    now[0] += loop_mod._DRIFT_REVIVE_GRACE_S
    assert ("c1", "mark-suspended") in reconcile_once(k, cap=10, rows=rows)
    assert _placement(pg, "c1") == (None, 4, "Suspended")


def test_unreadable_rows_skip_the_tick(pg):
    k = FakeK8s(PODS, [])
    rows = ConversationRows("host=/nonexistent user=postgres dbname=postgres")
    assert reconcile_once(k, cap=10, rows=rows) == []
    assert k.revives == []


def test_list_states_skips_rows_that_need_nothing(pg):
    _row(pg, "active", host="pod-a", gen=1, phase="Assigned")
    _row(pg, "pending")                                           # no phase yet
    _row(pg, "parked", gen=3, phase="Suspended", sandbox_ref="conv-parked")
    _row(pg, "zombie", gen=2, phase="Suspended", sandbox_ref="conv-zombie")
    _row(pg, "repairing", gen=2, phase="Suspended", sandbox_ref="conv-repairing")
    _row(pg, "stale-host", host="pod-b", gen=4, phase="Suspended", sandbox_ref="conv-stale")
    got = {r["id"] for r in ConversationRows(pg).list_states(running_refs={"conv-zombie"}, in_repair={"repairing"})}
    assert got == {"active", "pending", "zombie", "repairing", "stale-host"}


def test_a_parked_conversation_is_not_even_read(pg):
    _row(pg, "parked", gen=3, phase="Suspended", sandbox_ref="conv-parked")
    sb = SandboxRef("conv-parked", age_seconds=999, operating_mode="Suspended")
    k = FakeK8s(PODS, [], sandboxes=[sb])
    assert reconcile_once(k, cap=10, rows=ConversationRows(pg)) == []


def test_a_zombie_is_still_seen(pg):
    _row(pg, "zombie", gen=2, phase="Suspended", sandbox_ref="conv-zombie")
    sb = SandboxRef("conv-zombie", age_seconds=999, operating_mode="Running")
    k = FakeK8s(PODS, [], sandboxes=[sb])
    assert ("zombie", "suspend-sandbox-suspect") in reconcile_once(k, cap=10, rows=ConversationRows(pg))


def _subagent(dsn, conv_id, parent, phase="Pending"):
    _row(dsn, conv_id, phase=phase)
    _sql(dsn, "UPDATE conversations SET parent_id = %s WHERE id = %s", parent, conv_id)


def test_list_live_is_the_autoscale_demand(pg):
    _row(pg, "pending")                                   # phase NULL counts as Pending
    _row(pg, "assigned", host="pod-a", gen=1, phase="Assigned")
    _row(pg, "parked", phase="Suspended")
    _row(pg, "failed", phase="Failed")
    _row(pg, "suspended-but-hosted", host="pod-a", gen=2, phase="Suspended")
    _subagent(pg, "child", "assigned")
    live = {r["id"] for r in ConversationRows(pg).list_live()}
    assert live == {"pending", "assigned", "suspended-but-hosted", "child"}

    k = FakeK8s(PODS, [], replicas=1)
    m = autoscale_once(k, _Cfg(pod_cap=1, max_replicas=10), AutoscaleState(), now=1.0, rows=ConversationRows(pg))
    # The subagent and the parked/failed/suspended rows are not demand.
    assert m["demand"] == 2
    assert k.scale_calls == [2]


def test_the_reaper_spares_every_sandbox_a_row_references(pg):
    _row(pg, "c1", phase="Suspended", sandbox_ref="conv-c1")
    _row(pg, "c2", sandbox_ref="conv-c2")
    _row(pg, "c3")
    assert ConversationRows(pg).referenced_sandboxes() == {"conv-c1", "conv-c2"}

    sbs = [SandboxRef(n, age_seconds=1000) for n in ("conv-c1", "conv-c2", "conv-orphan")]
    k = FakeK8s([], [], sandboxes=sbs)
    assert reap_orphans(k, grace_seconds=600, rows=ConversationRows(pg)) == ["conv-orphan"]


def test_the_reaper_skips_when_postgres_is_down(pg):
    k = FakeK8s([], [], sandboxes=[SandboxRef("conv-x", age_seconds=1000)])
    rows = ConversationRows("host=/nonexistent user=postgres dbname=postgres connect_timeout=1")
    assert reap_orphans(k, grace_seconds=600, rows=rows) == []
    assert k.deleted_trees == []
