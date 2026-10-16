# Vendored: hydra-ahp protocol core

The Agent Host Protocol server core (JSON-RPC peer, channel store and reducers,
connection handling, WebSocket listener, token registry) from
[smagnuso/hydra-ahp](https://github.com/smagnuso/hydra-ahp), MIT-licensed (see
`LICENSE`), at commit `728b297a74de6787014b650d5214289ad242a48b` (2026-10-11).

Copied verbatim; only the files the core imports are included. Scooter's own code
lives in `../../` and plugs in through the `Backend` interface (`protocol/backend.ts`).
To update, re-copy the same files from a newer commit and bump the commit above.
