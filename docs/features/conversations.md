# Conversations & sandboxes

Every conversation owns a **cold, dedicated `Sandbox`** — not a claim from a shared pool. That
is what makes a per-conversation ServiceAccount and persistent volumes possible: the sandbox is
the conversation's durable body.

## The sandbox

- A NixOS image with **systemd as PID 1** — real services, timers, and a login environment,
  not a bare shell in a scratch container.
- The agent's tool calls **exec into the pod via the Kubernetes API**; there is no in-pod
  agent or HTTP server. The sandbox stays a clean execution environment.
- The agent can **modify its own environment** declaratively: it edits the machine's Nix
  configuration and rebuilds, and the change persists with the conversation.

## Suspend, don't delete

An idle conversation's sandbox is **suspended** (the pod is torn down; the `Sandbox` object and
its volumes remain). The next prompt revives it:

- the workspace volume comes back as it was,
- the conversation's transcript is re-injected into the agent's fresh session, so it continues
  with full context — whichever provider serves the run, including a bring-your-own container
  that has never seen the conversation before,
- suspended conversations cost no CPU; the platform autoscales its own hosts to live demand.

## Multi-replica by construction

Conversation ownership lives in a `Conversation` custom resource — the **source of truth** for
existence, ownership, and liveness. A controller assigns each conversation to a host pod;
routing follows the assignment; phase (live/suspended) is continuously reconciled against the
sandbox's real state. Any replica can serve any conversation after a reassignment, and a
rollout cannot strand one.

## Subagents

A conversation can spawn subagents: full conversations that **share the parent's sandbox pod**,
run asynchronously, and report back. The parent can monitor, search, and interrupt a running
subagent.

## Shared and private conversations

A conversation is **shared** by default: anyone signed in to the deployment can find it under
*Everyone*, read it, send it messages, and open its terminal, files and other services.

Its owner can make it **private** with the lock beside its title in the header. A private
conversation is visible to its owner alone: other users don't see it in the list, and its
history, its messages and its services answer them as if it did not exist. Making it private
also ends any event stream or terminal another user already had open. Subagents share their
parent's sandbox, so they are always exactly as private as their parent.

The owner can make a private conversation shared again after a warning: everything in it,
including whatever Scooter fetched while it was private, becomes visible to everyone.

Private means hidden from other Scooter users, not from the deployment's operators: anyone with
access to the cluster or the database can still read it. A conversation needs a signed-in
owner to be private, so a deployment without user identity has no private conversations.
