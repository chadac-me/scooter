"""Tier 1: Config.from_env, where the pool version key is derived from the same SANDBOX_IMAGE ref the provisioner keys on."""

import os
from contextlib import contextmanager

from warm_store_controller.config import Config


@contextmanager
def env(**kv):
    old = {k: os.environ.get(k) for k in kv}
    os.environ.update({k: v for k, v in kv.items() if v is not None})
    for k, v in kv.items():
        if v is None:
            os.environ.pop(k, None)
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def test_tag_derived_from_sandbox_image_ref():
    # SANDBOX_IMAGE carries a registry port and a git-sha tag.
    with env(SANDBOX_IMAGE="localhost:5000/agent-sandbox-os:scooter-git-abc123", SANDBOX_IMAGE_TAG=None):
        cfg = Config.from_env()
    assert cfg.current_image_tag == "scooter-git-abc123"
    assert cfg.warm_job_image == "localhost:5000/agent-sandbox-os:scooter-git-abc123"


def test_explicit_tag_override_wins():
    with env(SANDBOX_IMAGE="localhost:5000/agent-sandbox-os:latest", SANDBOX_IMAGE_TAG="pinned"):
        cfg = Config.from_env()
    assert cfg.current_image_tag == "pinned"


def test_no_image_no_tag():
    with env(SANDBOX_IMAGE=None, SANDBOX_IMAGE_TAG=None):
        cfg = Config.from_env()
    assert cfg.current_image_tag == ""


def test_user_namespace_from_env():
    with env(SANDBOX_USER_NAMESPACE="1"):
        assert Config.from_env().user_namespace is True
    with env(SANDBOX_USER_NAMESPACE=None):
        assert Config.from_env().user_namespace is False


def test_agent_host_is_the_default_caller():
    with env(NAMESPACE="scooter", WARM_STORE_ALLOWED_SUBJECTS=None):
        assert Config.from_env().allowed_subjects == {"system:serviceaccount:scooter:agent-host"}
