# Scooter

[![CI](https://github.com/chadac/scooter/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/chadac/scooter/actions/workflows/ci.yml)
[![Publish images](https://github.com/chadac/scooter/actions/workflows/publish-images.yml/badge.svg?branch=main)](https://github.com/chadac/scooter/actions/workflows/publish-images.yml)
[![Docs](https://github.com/chadac/scooter/actions/workflows/docs.yml/badge.svg?branch=main)](https://chadac.github.io/scooter/)
[![Container images](https://img.shields.io/badge/ghcr.io-chadac%2Fscooter-blue?logo=docker&logoColor=white)](https://github.com/chadac?tab=packages&repo_name=scooter)

Scooter is a self-hosted, open source, Kubernetes-based, agent chat platform. Scooter agents are superpowered developers with full power over their dev environment while being fully locked down and under your control. Agents can install tools, spawn web services, collaborate via [VS Code in the browser](https://github.com/coder/code-server), check out and build your software packages, and contribute back.

The key distinguishing feature of scooter is that it is designed to be **extensible from the ground up**: You can customize everything scooter can do, from the skills available to it, the services and tools that each agent has access to, its integrations with other services and permission-controlled access, and any custom scooter chat UI components that you would ever need.

It is configurable through a declarative configuration similar to [how NixOS is configured](https://wiki.nixos.org/wiki/NixOS_system_configuration), which means you can override ANY of scooter's defaults with your own preferences and extend it endlessly.

## Architecture

The core of scooter is five services:

* **The UI**, where your users can start new conversations, approve tasks, access any agent-hosted services, and view linked pull requests/JIRA issues/Slack threads per agent.

* **The agent host**, where agent conversations are hosted. Each agent (generally) communicates with the user through [goose](https://goose-docs.ai/), although [other ACP-powered integrations are possible](https://chadac.github.io/scooter/features/byoc/). Hosts scale with the number of active conversations, so you can save on costs during off-hours by running fewer (or even zero!) host pods.
  <!-- TODO: scale-to-zero is untested; verify before publishing. https://github.com/chadac/scooter/issues/817 -->

* **The agent sandbox**, the agent's execution environment. Powered through the [Kubernetes agent-sandbox CRD](https://agent-sandbox.sigs.k8s.io/).
  * Agents have full power of the sandbox environment with minimal risk of impacting other services on your cluster.
  * Sandboxes are capable of running web services that the user can interact with while remaining auth-gated: If you want to collaborate with the agent via vscode, [marimo](https://marimo.io/), [Jupyter](https://jupyter.org/), or any other service, the agent can easily set it up.
  * Sandboxes are automatically suspended after a configurable period of disuse to save on costs -- but they use volumes to ensure that resuming can be near-instantaneous.

* **The agent broker**: A bridge service that manages all requests from the agent host and sandbox to the outside world.
  * It **hides credentials from the agent** so that the agent isn't capable of even *accidentally* leaking credentials.
  * Brokers have **an expressive permission system** that is easily auditable and accessible via the UI. You as the platform owner define exactly which actions are allowed to be auto-approved and which would require approval from human users or a special set of users.

* **The webhooks service**: Manages forwarding webhooks to the appropriate agents. Scooter's broker and the webhooks service know how to implicitly associate agents with external resources so that interacting with scooter can be an extremely smooth experience:
  * Ping `@scooter` in Slack in a conversation to have it create a Jira issue for you;
  * Ping scooter on a Jira issue to have it pick up a PR; and
  * Provide a code review for scooter's PR and it responds to your comments.

These core four components provide you with **secure**, **powerful**, and **extensible** agents that can run at scale whenever needed.

## Getting started

You'll need a Kubernetes cluster with the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller installed,
[Nix with flakes](https://nixos.wiki/wiki/Flakes), and an ingress controller. A deployment is a small flake of your own
that imports Scooter and renders Kubernetes manifests with [kubenix](https://kubenix.org/):

```nix
# flake.nix
{
  inputs = {
    scooter.url = "github:chadac/scooter";
    flake-parts.follows = "scooter/flake-parts";
  };

  outputs = inputs@{ flake-parts, scooter, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { system, ... }: {
        packages.default =
          (scooter.lib.evalPlatform {
            inherit system;
            module = ./scooter.nix;
          }).config.kubernetes.result;
      };
    };
}
```

```nix
# scooter.nix
{
  scooter = {
    namespace = "scooter";
    ui.enable = true;
    broker.enable = true;
    ingress = {
      enable = true;
      host = "scooter.example.com";
      className = "nginx";
    };
    # Claude via AWS Bedrock, authenticated with an IRSA role.
    agent.availableModels.goose."us.anthropic.claude-sonnet-4-6".default = true;
    serviceAccountRoleArn = "arn:aws:iam::123456789012:role/scooter-agent-host";
  };
}
```

Then create the one required secret, render, and apply:

```bash
kubectl create namespace scooter
kubectl -n scooter create secret generic agent-conv-token-secret \
  --from-literal=secret="$(openssl rand -hex 32)"
nix build && kubectl apply -f result
```

Scooter trusts the identity header set by whatever sits in front of it, so put an auth
proxy (e.g. oauth2-proxy) in front of the UI before exposing it. The
[getting started guide](https://chadac.github.io/scooter/getting-started/) covers auth,
models, integrations and the other options you'll likely want.
