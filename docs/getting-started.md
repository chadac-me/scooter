# Getting started

Scooter deploys as a set of Kubernetes manifests rendered by [kubenix](https://kubenix.org/)
from one typed configuration module. You describe the platform in Nix: which services run,
which models the agent may use, which integrations it gets. Scooter renders the
Deployments, Services, RBAC and database setup from that, pinned to the images CI has
published.

This guide takes you from an empty cluster to a running deployment, then walks through
the options most deployments change.

## Prerequisites

- **A Kubernetes cluster** (k3s, kind, EKS, …) with the
  [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller installed.
  Scooter creates one `Sandbox` per conversation; the controller turns it into a pod.
- **Nix with flakes enabled**, on the machine you deploy from.
- **An ingress controller** (nginx, Traefik, …), so the UI is reachable from a browser.
- **An authenticating proxy** in front of the UI, such as
  [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/). Scooter does no login of
  its own; see [Authentication](#authentication).
- **A model provider**: AWS Bedrock, or a Claude subscription. See [Models](#models).

## 1. Create a deployment flake

Your deployment lives in its own repository, as a flake that takes Scooter as an input:

```nix
# flake.nix
{
  inputs = {
    scooter.url = "github:chadac/scooter";
    nixpkgs.follows = "scooter/nixpkgs";
    flake-parts.follows = "scooter/flake-parts";
  };

  outputs = inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ];
      perSystem = { system, ... }: {
        packages.default =
          (inputs.scooter.lib.evalPlatform {
            inherit system;
            module = ./scooter.nix;
          }).config.kubernetes.result;
      };
    };
}
```

`evalPlatform` is Scooter's entry point. It loads the platform modules and the image
definitions, so every image reference resolves to a content-addressed tag on
`ghcr.io/chadac/scooter`. You don't build any images yourself.

## 2. Write a minimal configuration

```nix
# scooter.nix
{
  scooter = {
    namespace = "scooter";

    # The chat UI, plus the broker that holds credentials on the agent's behalf.
    ui.enable = true;
    broker.enable = true;

    ingress = {
      enable = true;
      host = "scooter.example.com";
      className = "nginx";
    };

    # Claude via AWS Bedrock (the default provider), authenticated with an IRSA role
    # whose trust policy allows system:serviceaccount:scooter:agent-host.
    agent.availableModels.goose."us.anthropic.claude-sonnet-4-6".default = true;
    serviceAccountRoleArn = "arn:aws:iam::123456789012:role/scooter-agent-host";
  };
}
```

`scooter.nix` is an ordinary NixOS-style module: it can take `{ lib, ... }:`, use
`lib.mkForce`, import other files, and so on.

## 3. Create the secrets

Scooter never puts secret values in the rendered manifests. Secrets are created
out-of-band, and the config refers to them by name. The minimal configuration needs one,
the key that signs conversation tokens:

```bash
kubectl create namespace scooter
kubectl -n scooter create secret generic agent-conv-token-secret \
  --from-literal=secret="$(openssl rand -hex 32)"
```

Each feature below lists any secret it needs in the same way.

## 4. Render and deploy

```bash
nix build                  # renders ./result
kubectl apply -f result
kubectl -n scooter rollout status deploy/agent-host
```

Open `https://scooter.example.com` and start a conversation. To upgrade, run
`nix flake update scooter` and apply again. Only images CI has published are
deployable, so if you track a branch, wait for its images to publish first.

## Common options

Every option is listed with its type and default in the
[configuration reference](reference/options/index.md). These are the ones most
deployments touch.

### Authentication

The agent-host trusts an identity header set by the proxy in front of it, and treats a
request without one as `anonymous`. **Only expose Scooter through a proxy that sets
these headers and strips any copies the client sends**, or identities can be spoofed.

```nix
scooter.auth = {
  mode = "header";                  # or "alb-oidc" behind an AWS ALB
  userHeader = "x-forwarded-user";  # what oauth2-proxy sends in reverse-proxy mode
  emailHeader = "x-forwarded-email";
};
```

Rendered resources can be changed like any other kubenix config. For example, to route
the UI's ingress through oauth2-proxy instead of straight to the UI:

```nix
kubernetes.resources.ingresses.agent-host.spec.rules = lib.mkForce [{
  host = "scooter.example.com";
  http.paths = [{
    path = "/"; pathType = "Prefix";
    backend.service = { name = "oauth2-proxy"; port.number = 80; };
  }];
}];
```

### TLS

```nix
scooter.ingress = {
  tls = true;
  tlsSecretName = "scooter-tls";
  annotations."cert-manager.io/cluster-issuer" = "letsencrypt-prod";
};
```

### Models

The model catalog is keyed by provider, then model id. Each provider marks one
`default`, and the `hint` tells the agent when to switch to that model.

```nix
scooter.agent.availableModels.goose = {
  "us.anthropic.claude-sonnet-4-6" = {
    default = true;
    hint = "Fast and cheap: simple edits, CI fixes.";
  };
  "us.anthropic.claude-opus-4-8".hint = "Slow and powerful: design, hard debugging.";
};
```

To run on a **Claude subscription** instead of Bedrock, use the `claude-code` provider.
It needs the `agent-host-claude` image and a token from `claude setup-token`:

```nix
scooter.agent = {
  provider = "claude-code";
  claudeCode.tokenSecret = "agent-claude-code-token";
  availableModels."claude-code"."claude-sonnet-4-6".default = true;
};
```

```bash
kubectl -n scooter create secret generic agent-claude-code-token \
  --from-literal=token="$(claude setup-token)"
```

<!-- TODO: the agent-host-claude image currently has to be pinned by hand
     (scooter.images.agent-host.ref); document it properly once publishedAs lands. -->

Users can also connect their own Claude subscription from their laptop with
[bring-your-own-Claude](features/byoc.md) (`scooter.byoc.enable = true`).

### Integrations

Integrations are **contribs**, and each is off until you enable it. Their credentials
live in the broker, so the agent can use them without ever seeing them.

```nix
contribs = {
  # Git over HTTPS and the GitHub API, through a GitHub App.
  github = {
    enable = true;
    appId = "123456";
    installationId = "7890123";
    privateKeySecret = { name = "github-app-key"; key = "private-key"; };
  };
  # Web search. duckduckgo needs no key.
  duckduckgo.enable = true;
  brave = { enable = true; apiKeySecret.name = "brave-search"; };
  # The in-browser file viewer, with review comments that wake the agent.
  files.enable = true;
};
```

Other contribs include `aws` (scoped, time-limited AWS access with human approval),
`grafana`, `datadog`, `slack`, `jira`, `gitlab` and `airtable`. See
[Integrations](features/integrations.md).

### Webhooks: starting work from GitHub, Slack and Jira

The webhooks service turns events (a mention, a PR review) into conversations. It needs
its own **unauthenticated** ingress host, because providers sign their requests instead
of logging in.

```nix
scooter.webhooks = {
  enable = true;
  githubEnabled = true;
  githubApp = { appId = "123456"; privateKeySecret = { name = "github-app-key"; key = "private-key"; }; };
  secretName = "agent-webhooks-providers";  # holds GITHUB_WEBHOOK_SECRET
  ingress = { enable = true; host = "scooter-webhooks.example.com"; className = "nginx"; };
};
```

### Scheduled tasks

```nix
scooter.scheduler.enable = true;
```

This turns on the scheduled-tasks page and lets the agent schedule its own recurring
work.

### Sandboxes

```nix
scooter = {
  # The sizes the UI offers and the agent may request. Exactly one is the default.
  sandboxSizes = {
    small  = { cpu = "1"; memory = "2Gi";  hint = "Small repos."; };
    medium = { cpu = "2"; memory = "4Gi";  hint = "Builds and test suites."; default = true; };
    large  = { cpu = "4"; memory = "16Gi"; hint = "Parallel builds."; };
  };
  idleSuspendMs = 30 * 60 * 1000;  # suspend after 30 idle minutes
  sandboxRuntimeClass = "crun";    # optional; lets systemd run without privileges
  # Pre-warmed Nix stores, so new conversations start with common tools built.
  warmStore = { enable = true; goldenExpr = "nixpkgs#jq nixpkgs#nodejs"; };
};
```

### Skills

Skills are markdown files the agent reads at the start of each conversation. The
built-in ones come from the flake input (`inputs.scooter.lib.scooterSkills`), so the
simplest place to add your own is the module in `flake.nix`:

```nix
perSystem = { system, ... }: {
  packages.default =
    (inputs.scooter.lib.evalPlatform {
      inherit system;
      module = {
        imports = [ ./scooter.nix ];
        # Later entries win, so a file named like a built-in skill replaces it.
        scooter.agent.skills = inputs.scooter.lib.scooterSkills // {
          "our-repos.md" = builtins.readFile ./skills/our-repos.md;
        };
      };
    }).config.kubernetes.result;
};
```

Skills are read when a conversation starts, so changing one only needs a redeploy.

### Storage on single-node clusters

The agent-host shares two volumes across replicas, and they need `ReadWriteMany`.
Provisioners like k3s's `local-path` only support `ReadWriteOnce`, so on those clusters
use host paths instead:

```nix
scooter.conversationController = {
  historyMirror.hostPath = "/var/lib/scooter/agent-host-history";
  assets.hostPath = "/var/lib/scooter/agent-host-assets";
};
```

This only works while every agent-host pod runs on the same node.

## Next steps

- [`examples/kubenix-config.nix`](https://github.com/chadac/scooter/blob/main/examples/kubenix-config.nix)
  is a kitchen-sink example with every feature on. CI renders it, so it always evaluates.
- The [configuration reference](reference/options/index.md) documents every option.
- [Features](features/index.md) explains what each part of Scooter does.
