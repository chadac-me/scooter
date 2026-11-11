# Run it on your machine

One command runs Scooter on a laptop or a single server, with nothing of your own to set
up first:

```bash
nix run github:chadac-me/scooter#local -- up
```

It creates a small Kubernetes cluster in Docker with [k3d](https://k3d.io/), installs the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller, deploys
Scooter from the published images, asks once which model provider to use, and prints the
address of the chat: `http://localhost:8080`. The first run pulls about 1.3 GB of images
and takes a few minutes; later runs take about a minute.

## What you need

- **Nix** with flakes enabled ([install](https://nixos.org/download/)).
- **Docker**: the daemon on Linux, or Docker Desktop / OrbStack on macOS. k3d runs the
  cluster as containers.
- **4 CPUs and 8 GB of memory** to spare, more for several conversations at once. Each
  conversation runs in its own sandbox container with 1 CPU and 2 GB by default.
- **A model provider**, one of:
    - a **Claude subscription**: `claude setup-token` (from the Claude Code CLI) prints
      a long-lived token;
    - an **Anthropic API key** from [console.anthropic.com](https://console.anthropic.com/);
    - **[Ollama](https://ollama.com/)** on the same machine, with a model pulled. Nothing
      leaves your machine, but a model has to be good at tool use to drive a sandbox;
      try a coding model of 7B parameters or more.

## Commands

| Command | What it does |
|---|---|
| `scooter-local up` | Create or start the cluster and deploy. Asks for the provider and its credential the first time. Safe to re-run. |
| `scooter-local down` | Stop the cluster. Conversations, sandboxes and uploaded files are kept; `up` brings them back. |
| `scooter-local destroy` | Delete the cluster and everything in it. |
| `scooter-local status` | The cluster's state, its pods, and the URL. |
| `scooter-local logs` | Follow the agent-host's log. |
| `scooter-local config` | Choose the provider or credential again; the next `up` applies it. |
| `scooter-local kubeconfig` | The kubeconfig path, for `kubectl` against the cluster. |

`nix run github:chadac-me/scooter#local -- <command>` runs each; `nix profile install
github:chadac-me/scooter#scooter-local` puts `scooter-local` on your PATH.

The cluster is named `scooter`, and the state (the kubeconfig, the chosen provider, the
uploaded files) lives in `~/.local/state/scooter-local`. Credentials are stored only in
the cluster, as Secrets.

For a script or a CI job, the prompts can be answered from the environment:
`SCOOTER_LOCAL_PROVIDER=claude-code|anthropic|ollama`, and `CLAUDE_CODE_OAUTH_TOKEN`,
`ANTHROPIC_API_KEY` or `OLLAMA_MODEL`. `SCOOTER_LOCAL_PORT` changes the port.

## What runs

The same platform a cluster deployment runs, configured by the `local` preset
([`modules/local.nix`](https://github.com/chadac-me/scooter/blob/main/modules/local.nix)):

- the agent-host, UI, broker and conversation controller, one replica each, and Postgres
  in the cluster;
- the stock Ingress, served by the Traefik that k3s ships, on the port k3d maps to
  `localhost`;
- the uploads volume on a host directory (the single-node escape hatch described in
  [Getting started](../getting-started.md#storage-on-single-node-clusters));
- Scooter's own agent skills, and the contribs that need no credentials: web search
  (DuckDuckGo), file attachments, personal skills, personalization, hand-off, shares and
  commits. [Setting up contribs](contribs.md) adds the rest.

Each conversation still gets its own NixOS sandbox: a container inside the k3d node, with
its workspace on a volume that survives `down`.

## What a single machine does not do

**There is no login.** Scooter trusts whatever identity sits in front of it, and here
nothing does: everyone who can reach the port is the same user. The port is bound to
`127.0.0.1`, so that is only your machine; do not forward it to a network. For other
people, make a real deployment ([Getting started](../getting-started.md)).

**Sandboxes run privileged.** Without a cgroup-delegating runtime such as crun in the
cluster, the sandbox's systemd needs a privileged container, which here is a container
inside the k3d node's container. That is fine for your own machine and your own
conversations; it is one of the things a cluster deployment sets up differently
(`scooter.sandboxRuntimeClass`).

**Webhooks and the scheduler are off**, since nothing can reach the machine from
GitHub or Slack. Bring-your-own-Claude is off too: the model already runs on your
subscription.

**Everything is on one disk**: Postgres and the sandbox volumes live in the k3d node's
Docker volume, and the uploads in the state directory. `destroy` removes all of it.

## From here to a deployment

The preset is an ordinary Scooter module, so the same configuration can grow into a
deployment of your own:

```bash
nix flake init -t github:chadac-me/scooter#local
```

writes a `flake.nix` that imports the preset and a `scooter.nix` for your settings on
top of it; every setting in the preset is a default, so yours win. From there,
[Getting started](../getting-started.md) and [Deploying Scooter](deploying/index.md)
cover authentication, a hostname, and a cluster.

!!! note "The Claude image tag"
    With the `claude-code` provider the agent-host runs the `agent-host-claude` image,
    whose tag Scooter cannot yet compute in the render
    ([#824](https://github.com/chadac-me/scooter/issues/824)). `scooter-local up` resolves
    it with one `nix eval` the first time, and caches it. A deployment of your own sets
    `scooter.local.agentHostClaudeTag` the way
    [Running on a Claude subscription](deploying/published-images.md#running-on-a-claude-subscription)
    describes. `SCOOTER_LOCAL_CLAUDE_TAG` overrides it for `scooter-local`.

## Troubleshooting

- **`docker is installed but the daemon is not reachable`**: start Docker (Desktop) and
  retry; on Linux make sure your user may use the socket.
- **`some images are not published for this revision`**: CI publishes the images of
  `main` and of every release, so run from one of those
  (`nix run github:chadac-me/scooter#local`, or `…/scooter/v1.5.0#local`) rather than
  from a branch or an unpublished commit.
- **A pod stays `Pending` or `ImagePullBackOff`**: `scooter-local status` shows the
  pods; `kubectl --kubeconfig $(scooter-local kubeconfig) -n scooter describe pod <name>`
  says why. Memory is the usual reason on a small machine.
- **The agent answers nothing** with Ollama: `ollama serve` must be running and the
  model pulled; `scooter-local logs` shows goose's errors.
- **Start over**: `scooter-local destroy`, then `up`.
