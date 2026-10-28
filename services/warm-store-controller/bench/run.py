"""One benchmark round: each case's median, as JSON lines."""

from __future__ import annotations

import argparse
import json
import logging
import os
import statistics
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (380, 2000)


def _fake(n: int) -> tuple[subprocess.Popen, int]:
    p = subprocess.Popen(
        [sys.executable, "-I", os.path.join(HERE, "fake_apiserver.py"), "--pvs", str(n)],
        stdout=subprocess.PIPE, text=True,
    )
    return p, int(p.stdout.readline())


def _point_client_at(port: int) -> None:
    from kubernetes import client, config

    cfg = client.Configuration()
    cfg.host = f"http://127.0.0.1:{port}"

    def load(*_a, **_k) -> None:
        client.Configuration.set_default(cfg)

    config.load_incluster_config = load


def _median(fn, clock, iters: int) -> float:
    for _ in range(2):
        fn()
    out = []
    for _ in range(iters):
        t = clock()
        fn()
        out.append(1000 * (clock() - t))
    return statistics.median(out)


def bench(iters: int) -> list[tuple[str, str, float]]:
    from warm_store_controller import k8s as k8smod
    from warm_store_controller.janitor import UpkeepConfig
    from warm_store_controller.loop import PassState, reconcile_once
    from warm_store_controller.reserve import Misses, Reserver
    from warm_store_controller.sizing import ActuatorConfig, FixedPolicy

    import fake_apiserver as fa

    rows = []
    for n in SIZES:
        proc, port = _fake(n)
        try:
            _point_client_at(port)
            k8smod._core = None  # rebuild clients against this server
            k = k8smod.ControllerK8s(namespace=fa.NS, pool_storage_class=fa.POOL_CLASS, warm_job_image=f"img:{fa.TAG}")
            lock = threading.Lock()
            reserver = Reserver(k, lock, Misses())
            upkeep = UpkeepConfig(current_tag=fa.TAG, pool_class=fa.POOL_CLASS, reserve_grace=600.0, marker_retries=3)
            actuator = ActuatorConfig(max_warm=8, max_warm_jobs=2, cooldown=1800.0, max_returned=5, returned_ttl=86400.0)

            def one_pass(state=PassState()) -> None:
                reconcile_once(k, upkeep, FixedPolicy(1), actuator, state, Misses(), lock)

            def reserve() -> None:
                assert reserver.reserve(fa.SANDBOX, fa.TAG).pv is not None

            cpu, wall = time.process_time, time.perf_counter
            rows.append((f"list_pvs+pool_pvs/{n}", "ms_cpu", _median(lambda: k.pool_pvs(k.list_pvs()), cpu, iters)))
            rows.append((f"reserve/{n}", "ms_cpu", _median(reserve, cpu, iters)))
            rows.append((f"reserve/{n}", "ms_wall", _median(reserve, wall, iters)))
            rows.append((f"reconcile_once/{n}", "ms_cpu", _median(one_pass, cpu, max(3, iters // 3))))

            # Passes on another thread, as in production.
            stop = threading.Event()

            def passes() -> None:
                while not stop.is_set():
                    one_pass()

            t = threading.Thread(target=passes, daemon=True)
            t.start()
            try:
                rows.append((f"reserve during a pass/{n}", "ms_wall", _median(reserve, wall, iters)))
            finally:
                stop.set()
                t.join()
        finally:
            proc.kill()
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="the warm-store-controller tree to import")
    ap.add_argument("--side", default="", help="copied into every line, e.g. base or pr")
    ap.add_argument("--iters", type=int, default=7)
    a = ap.parse_args()
    sys.path[:0] = [os.path.abspath(a.src), HERE]
    # Log handlers' cost is not what we measure.
    logging.disable(logging.CRITICAL)
    for case, unit, value in bench(a.iters):
        print(json.dumps({"suite": "warm-store", "side": a.side, "case": case, "unit": unit, "value": round(value, 3)}))


if __name__ == "__main__":
    main()
