# Architecture

Scooter runs the agent **outside** its sandbox. The agent-host runs the agent process
(Goose over ACP, by default) and carries out each tool call by exec'ing into the
conversation's sandbox pod through the Kubernetes API. The sandbox is a plain NixOS
machine with no agent inside it. Everything it reaches outside the cluster goes through
the broker, which holds the credentials.

```mermaid
flowchart TB
    user(["User's browser"])
    ext(["GitHub · GitLab · Slack · Jira"])
    byocbox(["BYOC container<br/>on the user's machine"])

    subgraph ns["Scooter namespace"]
        direction TB
        ui["UI<br/>nginx + assistant-ui"]
        webhooks["webhooks"]
        sched["scheduler"]
        router["conversation-router<br/>routes to the owning host"]
        ctrl["conversation-controller<br/>assigns + autoscales hosts"]
        host["agent-host replicas<br/>AG-UI ↔ ACP bridge, goose"]
        byocctl["byoc-controller"]
        pg[("Postgres")]
        broker["broker<br/>credentials, approvals,<br/>forge proxy"]

        subgraph conv["Per conversation"]
            sandbox["Sandbox pod<br/>NixOS + systemd,<br/>own ServiceAccount"]
            pvc[("workspace + /nix PVCs")]
        end
    end

    world(["Forges, cloud APIs,<br/>model providers"])

    user -->|"Ingress"| ui
    user -->|"*.sandboxDomain"| router
    ext --> webhooks
    ui --> router
    webhooks --> router
    sched --> router
    router --> host
    router -.->|"web services"| sandbox
    ctrl --> pg
    router --> pg
    host --> pg
    byocbox <-->|"WebSocket"| byocctl
    byocctl <--> host
    host -->|"pods/exec via agent-sandbox"| sandbox
    sandbox --- pvc
    sandbox -->|"SA token"| broker
    host --> broker
    broker --> world
    host -->|"model calls"| world
```

## Components

| Component | What it does |
|---|---|
| **UI** | Serves the chat app. Its nginx proxies the API to the router and contribs' public paths to the broker. |
| **conversation-router** | Sits in front of every agent-host. It looks up which host pod owns a conversation and proxies the request (HTTP, SSE or WebSocket) there. It also serves each conversation's web services on `*.sandboxDomain`. |
| **conversation-controller** | Leader-elected. It assigns each conversation to an agent-host pod in Postgres and reassigns conversations when a pod goes away, so any replica can pick up any conversation. It also scales the agent-host fleet to demand. |
| **agent-host** | Runs one agent session per live conversation and bridges ACP to AG-UI for the browser. It provisions, suspends and resumes sandboxes, and runs tool calls by exec'ing into them. |
| **Sandbox** | A `Sandbox` object from [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox), one per conversation. It has its own ServiceAccount and PVCs, so suspending an idle sandbox keeps the workspace and installed tools. |
| **broker** | The only holder of credentials. It authenticates sandboxes by their ServiceAccount token (TokenReview), applies the permission rules and approvals, and vends short-lived credentials or proxies the request. Forge traffic (`git`, `gh`) goes through its proxy, so the sandbox never holds a token. |
| **webhooks** | Receives GitHub, GitLab, Slack and Jira events and turns them into prompts for the right conversation. |
| **scheduler** | Fires scheduled tasks as new or existing conversations. |
| **byoc-controller** | Optional. Holds the WebSocket from each [bring-your-own-Claude](features/byoc.md) container so any agent-host can drive it. |
| **Postgres** | Shared durable store. Each service has its own database: conversation ownership, transcripts, tasks, broker state. |

## Network boundaries

When the CNI enforces NetworkPolicy, Scooter's policies mean that:

- sandboxes reach only the broker, its forge proxy, the router's self-access listener, DNS and the internet, and never each other;
- only platform pods reach a sandbox;
- only the router and the conversation-controller reach agent-host pods.
