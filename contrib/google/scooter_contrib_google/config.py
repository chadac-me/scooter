"""Google settings, owned by this contrib."""

from __future__ import annotations

from scooter_lib.settings import ScooterBaseSettings

# Read-only by default: the scopes are the real write gate, Google enforces them.
DEFAULT_SCOPES = (
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/documents.readonly",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/presentations.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
    "https://www.googleapis.com/auth/gmail.readonly",
)


def split_list(raw: str) -> list[str]:
    """Split a space- or comma-separated env value, dropping blanks."""
    return [s for s in raw.replace(",", " ").split() if s]


class GoogleSettings(ScooterBaseSettings):
    # The service-account key file's JSON contents.
    google_service_account_json: str = ""
    # The Workspace user to impersonate via domain-wide delegation; empty acts as the service account itself.
    google_subject: str = ""
    # Impersonate the conversation owner instead, when their email is in one of these domains.
    google_impersonate_owner: bool = False
    google_owner_domains: str = ""
    google_scopes: str = ""

    @property
    def scopes(self) -> list[str]:
        return split_list(self.google_scopes) or list(DEFAULT_SCOPES)

    @property
    def owner_domains(self) -> set[str]:
        return {d.lower().lstrip("@") for d in split_list(self.google_owner_domains)}
