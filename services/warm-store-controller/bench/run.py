"""warm-store benchmarks as a pyperf runner; pyperf's own flags apply."""

from __future__ import annotations

import atexit
import logging
import os
import subprocess
import sys
import threading
import time

import pyperf

HERE = os.path.dirname(os.path.abspath(__file__))
SIZES = (380, 2000)


def _fake(n: int) -> tuple[subprocess.Popen, int]:
    p = subprocess.Popen(
        [sys.executable, "-I", os.path.join(HERE, "fake_apiserver.py"), "--pvs", str(n)],
        stdout=subprocess.PIPE, text=True,
    )
    atexit.register(p.kill)
    return p, int(p.stdout.readline())


def _point_client_at(port: int) -> None:
    from kubernetes import client, config

    cfg = client.Configuration()
    cfg.host = f"http://127.0.0.1:{port}"

    def load(*_a, **_k) -> None:
        client.Configuration.set_default(cfg)

    config.load_incluster_config = load


class Cluster:
    """A controller wired to a fake API server holding n PVs."""

    def __init__(self, n: int) -> None:
        from warm_store_controller import k8s as k8smod
        from warm_store_controller.janitor import UpkeepConfig
        from warm_store_controller.loop import PassState, reconcile_once
        from warm_store_controller.reserve import Misses, Reserver
        from warm_store_controller.sizing import ActuatorConfig, FixedPolicy

        import fake_apiserver as fa

        self.proc, port = _fake(n)
        _point_client_at(port)
        k8smod._core = None  # rebuild clients against this server
        k = k8smod.ControllerK8s(namespace=fa.NS, pool_storage_class=fa.POOL_CLASS, warm_job_image=f"img:{fa.TAG}")
        lock = threading.Lock()
        reserver = Reserver(k, lock, Misses())
        upkeep = UpkeepConfig(current_tag=fa.TAG, pool_class=fa.POOL_CLASS, reserve_grace=600.0, marker_retries=3)
        actuator = ActuatorConfig(max_warm=8, max_warm_jobs=2, cooldown=1800.0, max_returned=5, returned_ttl=86400.0)
        state = PassState()

        self.list = lambda: k.pool_pvs(k.list_pvs())
        self.one_pass = lambda: reconcile_once(k, upkeep, FixedPolicy(1), actuator, state, Misses(), lock)

        def reserve() -> None:
            assert reserver.reserve(fa.SANDBOX, fa.TAG).pv is not None

        self.reserve = reserve


_clusters: dict[int, Cluster] = {}


def cluster(n: int) -> Cluster:
    # A worker runs one benchmark, so it starts one server.
    if n not in _clusters:
        _clusters[n] = Cluster(n)
    return _clusters[n]


def timed(clock, n: int, fn_name: str):
    def run(loops: int) -> float:
        fn = getattr(cluster(n), fn_name)
        t = clock()
        for _ in range(loops):
            fn()
        return clock() - t

    return run


def during_passes(n: int):
    def run(loops: int) -> float:
        c = cluster(n)
        stop = threading.Event()

        def passes() -> None:
            while not stop.is_set():
                c.one_pass()

        t = threading.Thread(target=passes, daemon=True)
        t.start()
        try:
            return timed(time.perf_counter, n, "reserve")(loops)
        finally:
            stop.set()
            t.join()

    return run


def main() -> None:
    runner = pyperf.Runner(
        processes=4, values=3, warmups=1,
        add_cmdline_args=lambda cmd, args: cmd.extend(["--src", args.src]),
    )
    runner.argparser.add_argument("--src", required=True, help="the warm-store-controller tree to import")
    args = runner.parse_args()
    sys.path[:0] = [os.path.abspath(args.src), HERE]
    # Log handlers' cost is not what we measure.
    logging.disable(logging.CRITICAL)
    cpu, wall = time.process_time, time.perf_counter
    for n in SIZES:
        runner.bench_time_func(f"list_pvs+pool_pvs/{n} (cpu)", timed(cpu, n, "list"))
        runner.bench_time_func(f"reserve/{n} (cpu)", timed(cpu, n, "reserve"))
        runner.bench_time_func(f"reserve/{n} (wall)", timed(wall, n, "reserve"))
        runner.bench_time_func(f"reconcile_once/{n} (cpu)", timed(cpu, n, "one_pass"))
        runner.bench_time_func(f"reserve during passes/{n} (wall)", during_passes(n))


if __name__ == "__main__":
    main()
