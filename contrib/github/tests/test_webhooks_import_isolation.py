"""The webhooks service ships without the broker lib, so its handler must import without it."""

import os
import subprocess
import sys


def test_webhooks_handler_imports_without_the_broker_lib():
    # Regression: forge.py imported scooter_broker_lib at module level, so the
    # handler failed to load and every POST /webhooks/github returned 404.
    code = (
        "import sys; sys.modules['scooter_broker_lib'] = None; "
        "import scooter_contrib_github.webhooks_handler"
    )
    res = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=dict(os.environ))
    assert res.returncode == 0, res.stderr


def test_forge_hosts_still_works_with_the_broker_lib():
    from scooter_contrib_github.forge import forge_hosts

    hosts = forge_hosts("github.com")
    assert [h.host for h in hosts] == ["github.com", "api.github.com", "uploads.github.com"]
