"""imagegen: a generate_image agent tool backed by pluggable backends.

Neutral; imports neither broker nor webhooks. The provider half is
broker_provider.py, loaded only in the broker image.
"""
