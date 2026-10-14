"""reconcile_once with the conversations row as the source of truth, on a real Postgres."""

import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from conversation_controller.loop import reconcile_once
from conversation_controller.reconcile import Pod, SandboxRef
from conversation_controller.rows import ConversationRows

from .test_loop import FakeK8s, _cr, _reset_zombie_state  # noqa: F401  (autouse reset)

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


def test_a_router_claim_is_kept_and_mirrored_to_the_cr(pg):
    _row(pg, "c1", host="pod-b", gen=1, phase="Assigned")
    k = FakeK8s(PODS, [_cr("c1")])  # the CR has no placement yet
    reconcile_once(k, cap=10, rows=ConversationRows(pg))
    assert _placement(pg, "c1") == ("pod-b", 1, "Assigned")
    assert k.status("c1")["hostPod"] == "pod-b"
    assert k.status("c1")["generation"] == 1
    assert k.status("c1")["hostIP"] == "10.0.0.2"


def test_an_unassigned_row_is_assigned_in_the_row(pg):
    _row(pg, "c1")
    k = FakeK8s(PODS, [_cr("c1")])
    reconcile_once(k, cap=10, rows=ConversationRows(pg))
    host, gen, phase = _placement(pg, "c1")
    assert host in ("pod-a", "pod-b") and gen == 1 and phase == "Assigned"
    assert k.status("c1")["hostPod"] == host


def test_the_cr_never_overwrites_the_row(pg):
    _row(pg, "c1", host="pod-b", gen=3, phase="Assigned")
    # A stale CR from before the router claimed.
    k = FakeK8s(PODS, [_cr("c1", host="pod-a", phase="Assigned", gen=2, host_ip="10.0.0.1")])
    reconcile_once(k, cap=10, rows=ConversationRows(pg))
    assert _placement(pg, "c1") == ("pod-b", 3, "Assigned")
    assert k.status("c1")["hostPod"] == "pod-b"


def test_losing_to_a_router_claim_leaves_the_winner(pg, monkeypatch):
    _row(pg, "c1")
    rows = ConversationRows(pg)
    snapshot = rows.list_states(set(), set())
    # The router claims between the controller's read and its write.
    _sql(pg, "UPDATE conversations SET host_pod = 'pod-b', host_generation = 1 WHERE id = 'c1'")
    monkeypatch.setattr(rows, "list_states", lambda *_: snapshot)
    k = FakeK8s([Pod("pod-a", True, ip="10.0.0.1")], [_cr("c1")])
    assert ("c1", "assign-lost") in reconcile_once(k, cap=10, rows=rows)
    assert _placement(pg, "c1")[:2] == ("pod-b", 1)
    assert k.revives == []


def test_a_claimed_revive_gets_a_tick_to_resume_its_sandbox(pg):
    # A claimed revive whose sandbox has not resumed yet.
    _row(pg, "c1", host="pod-a", gen=4, phase="Assigned", sandbox_ref="conv-c1")
    sb = SandboxRef("conv-c1", age_seconds=999, operating_mode="Suspended")
    k = FakeK8s(PODS, [_cr("c1", phase="Suspended", gen=3)], sandboxes=[sb])
    assert ("c1", "drift-grace") in reconcile_once(k, cap=10, rows=ConversationRows(pg))
    assert _placement(pg, "c1") == ("pod-a", 4, "Assigned")


def test_drift_that_persists_is_still_repaired(pg):
    _row(pg, "c1", host="pod-a", gen=4, phase="Assigned", sandbox_ref="conv-c1")
    sb = SandboxRef("conv-c1", age_seconds=999, operating_mode="Suspended")
    k = FakeK8s(PODS, [_cr("c1")], sandboxes=[sb])
    rows = ConversationRows(pg)
    reconcile_once(k, cap=10, rows=rows)
    assert ("c1", "mark-suspended") in reconcile_once(k, cap=10, rows=rows)
    assert _placement(pg, "c1") == (None, 4, "Suspended")


def test_unreadable_rows_skip_the_tick(pg):
    k = FakeK8s(PODS, [_cr("c1")])
    rows = ConversationRows("host=/nonexistent user=postgres dbname=postgres")
    assert reconcile_once(k, cap=10, rows=rows) == []
    assert k.patches == []


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
    k = FakeK8s(PODS, [_cr("parked", phase="Suspended", gen=3)], sandboxes=[sb])
    assert reconcile_once(k, cap=10, rows=ConversationRows(pg)) == []


def test_a_zombie_is_still_seen(pg):
    _row(pg, "zombie", gen=2, phase="Suspended", sandbox_ref="conv-zombie")
    sb = SandboxRef("conv-zombie", age_seconds=999, operating_mode="Running")
    k = FakeK8s(PODS, [_cr("zombie", phase="Suspended", gen=2)], sandboxes=[sb])
    assert ("zombie", "suspend-sandbox-suspect") in reconcile_once(k, cap=10, rows=ConversationRows(pg))
