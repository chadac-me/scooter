# The deployment half

A contrib whose settings are only environment variables needs no deployment half: its
`services.<svc>.env` in [`contrib.nix`](declaration.md) puts them on the broker and
webhooks containers. `deployment.nix` is for everything else a contrib renders into
Kubernetes: env in every sandbox, a mounted ConfigMap, an IAM annotation. It's a
**kubenix module** in the same evaluation as the rest of the platform, so it can read
the whole `scooter.*` tree and write to the seams the services expose.

There's nothing to register. The platform imports `deployment.nix` from next to each
`contrib.nix` automatically.

```nix
# contrib/acme/deployment.nix
{ config, lib, ... }:

let
  ccfg = config.contribs.acme;
in
{
  # Render nothing unless the contrib is enabled and its service is deployed.
  config = lib.mkIf (config.scooter.broker.enable && ccfg.enable) {
    # Tell the `acme` CLI in every sandbox where the instance is.
    scooter.sandboxPod.extraEnv = [
      { name = "ACME_SITE_URL"; value = ccfg.siteUrl; }
    ];
  };
}
```

Two rules:

- **Gate everything on `ccfg.enable`.** The module is imported whether or not the contrib
  is enabled, so the `mkIf` is what keeps a disabled contrib inert.
- **Never put a secret value in Nix.** Refer to a Secret with `secretKeyRef`. The rendered
  manifests contain only the Secret's name.

## The seams

Add to existing Deployments through these options rather than redeclaring their
containers:

| To add… | Use |
|---|---|
| env on the broker or webhooks | `services.<svc>.env` in `contrib.nix` |
| a volume on the broker | `scooter.broker.extraVolumes` and `scooter.broker.extraVolumeMounts` |
| a rollout when your config changes | `scooter.broker.podAnnotations` (put a hash of the ConfigMap in it) |
| a cloud identity (e.g. IRSA) | `scooter.broker.serviceAccountAnnotations` |
| env or volumes in every sandbox | `scooter.sandboxPod.extraEnv`, `extraVolumes`, `extraVolumeMounts` |
| human approvals | `scooter.approvals.<name>` ([Broker provider](broker.md#human-approvals)) |
| anything new of your own | `kubernetes.resources.*` |

Kubernetes keeps the **last** value when an env name appears twice, without an error, so
prefix every variable with your contrib's name (`ACME_*`).

For example, `contrib/aws` renders its account list into a ConfigMap, mounts it in the
broker, and annotates the pod with the ConfigMap's hash so that changing an account rolls
the broker:

```nix
kubernetes.resources.configMaps.agent-broker-acme = {
  metadata.namespace = config.scooter.namespace;
  data."projects.json" = builtins.toJSON ccfg.projects;
};

scooter.broker = {
  extraVolumes = [ { name = "acme"; configMap.name = "agent-broker-acme"; } ];
  extraVolumeMounts = [ { name = "acme"; mountPath = "/etc/agent-broker/acme"; readOnly = true; } ];
  podAnnotations."scooter.chadac.dev/acme-hash" =
    builtins.hashString "sha256" (builtins.toJSON ccfg.projects);
};
```

## Webhooks settings

Set the webhooks container's env with `services.webhooks.env`, as for the broker; jira
sets `JIRA_ENABLED` that way. A webhook signing secret usually lives in the one Secret
the service already reads, `scooter.webhooks.secretName`, whose keys become environment
variables. So the operator adds `ACME_WEBHOOK_SECRET` to that Secret, as for the
[Jira webhook](../webhooks.md#jira).

## Check the render

Render the repo's kitchen-sink example with your contrib configured (see
[Testing and shipping](testing.md)), then look at what came out:

```bash
just check-manifests                          # the example's assertions
nix build .#example-manifests -o example.yaml # the rendered YAML
grep -n -A3 'ACME_' example.yaml
```

Next: [the broker provider](broker.md).
