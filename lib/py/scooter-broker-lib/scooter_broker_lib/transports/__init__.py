"""Transports: how a resolved credential is delivered to the sandbox.

Each implements the `Transport` protocol from `..types` and mounts its own routes
under the provider's prefix: an authenticating HTTP proxy, a git-credential helper,
a raw token vend, a diagnostic whoami, and the MCP tool server.
"""
