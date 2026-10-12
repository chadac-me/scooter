"""Static shares: broker-hosted static webpages that persist past a session.

An agent publishes a bundle of static files and the broker mints a UUID and serves it at
a capability-style URL (/s/<uuid>/, /s/<uuid>/<path>, /s/<uuid>/v/<n>/...). The UUID is
the identity, ownership lives in the DB row keyed by it, and updating a share keeps the
UUID and adds a version. Persistence is isolated in shares/store.py behind the ShareStore API.
"""
