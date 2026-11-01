"""Google Cloud settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings

# The service account's IAM roles are the gate; this scope defers to them.
DEFAULT_SCOPES = ("https://www.googleapis.com/auth/cloud-platform",)

# googleapis.com subdomains for resource management and monitoring.
DEFAULT_HOSTS = (
    # Projects, APIs, billing, IAM, inventory.
    "cloudresourcemanager", "serviceusage", "cloudbilling", "billingbudgets",
    "iam", "cloudasset", "recommender", "orgpolicy",
    # Compute and serverless.
    "compute", "container", "run", "cloudfunctions", "appengine", "cloudbuild",
    "artifactregistry", "cloudscheduler", "cloudtasks", "workflows", "eventarc",
    # Data.
    "storage", "bigquery", "sqladmin", "pubsub", "redis", "spanner", "firestore",
    "dataflow", "dataproc",
    # Security and networking.
    "secretmanager", "cloudkms", "dns", "certificatemanager", "networkmanagement",
    # Observability.
    "monitoring", "logging", "cloudtrace", "clouderrorreporting",
)

_SUFFIX = ".googleapis.com"


def split_list(raw: str) -> list[str]:
    """Split a space- or comma-separated env value, dropping blanks."""
    return [s for s in raw.replace(",", " ").split() if s]


def full_host(name: str) -> str:
    """`compute` -> `compute.googleapis.com`; a full googleapis.com name passes through."""
    name = name.strip().lower().rstrip(".")
    host = name if "." in name else name + _SUFFIX
    # Anything else would send a Google token to a non-Google host.
    if not host.endswith(_SUFFIX) or host == _SUFFIX.lstrip("."):
        raise ValueError(f"{name!r} is not a googleapis.com host")
    return host


class GcpSettings(ScooterBaseSettings):
    # The service-account key file's JSON contents.
    gcp_service_account_json: str = ""
    gcp_scopes: str = ""
    # Hosts intercepted on top of DEFAULT_HOSTS, e.g. `aiplatform` or `us-central1-run.googleapis.com`.
    gcp_extra_hosts: str = ""
    gcp_forge_policy: str = ""

    @property
    def scopes(self) -> list[str]:
        return split_list(self.gcp_scopes) or list(DEFAULT_SCOPES)

    @property
    def hosts(self) -> list[str]:
        return sorted({full_host(h) for h in (*DEFAULT_HOSTS, *split_list(self.gcp_extra_hosts))})
