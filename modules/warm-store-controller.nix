# The warm /nix/store PVC pool controller (Deployment, SA and RBAC): a
# leader-elected reconcile loop that keeps overlay-upper PVCs warmed against the
# current sandbox image tag, GCs retired tags, returns claimed PVCs on suspend
# and recovers leaks. The agent-host provisioner does the claim. Off by default,
# since the pool is a hit-rate optimization and not a correctness dependency.

{ config, lib, ... }:

let
  cfg = config.scooter;
  wcfg = cfg.warmStore;
in
{
  options.scooter.warmStore = with lib; {
    enable = mkEnableOption "the warm /nix/store PVC pool controller";

    image = mkOption {
      type = types.str;
      default = cfg.images.warm-store-controller.ref.fullUrl;
      defaultText = literalExpression "config.scooter.images.warm-store-controller.ref.fullUrl";
      description = "OCI ref of the warm-store-controller image.";
    };
    replicas = mkOption {
      type = types.int;
      default = 1;
      description = ''
        Controller replicas. Default 1: the controller is leader-elected (only the leader
        reconciles), so a 2nd replica only buys faster failover — not worth it for a pool
        controller whose work is a hit-rate optimization (a brief reconcile gap on pod
        restart just delays a warm/GC, never blocks a conversation). Set >1 for HA.
      '';
    };
    minReady = mkOption {
      type = types.int;
      default = 1;
      description = "Keep at least this many `ready` pool PVCs warmed for the current image tag.";
    };
    maxTotal = mkOption {
      type = types.int;
      default = 8;
      description = "Cap total `ready` pool PVCs for the current tag (LRU-evict the coldest past this).";
    };
    storage = mkOption {
      type = types.str;
      default = "20Gi";
      description = "Size of each pool PVC (the overlay upper). Match the per-conversation scooter-rw size.";
    };
    storageClass = mkOption {
      type = types.str;
      default = "warm-store-retain";
      description = ''
        StorageClass for POOL volumes. MUST have `reclaimPolicy: Retain`: on a Delete class
        removing a PVC destroys its PV, so nothing is ever recycled and the pool silently
        degrades to "always a fresh empty upper" with no symptom.

        Created by this module over `storageProvisioner`. Point it at a class you manage
        yourself by also setting `storageProvisioner = null`.
      '';
    };
    storageProvisioner = mkOption {
      type = types.nullOr types.str;
      default = "rancher.io/local-path";
      description = ''
        Provisioner backing the pool StorageClass — a Retain variant of the cluster's normal
        one, so no new CSI driver is needed (e.g. `ebs.csi.aws.com` on EKS). null ⇒ do not
        create the class; `storageClass` must then already exist.
      '';
    };
    goldenExpr = mkOption {
      type = types.str;
      default = "";
      example = ''nixpkgs#awscli2 nixpkgs#nodejs nixpkgs#python3'';
      description = ''
        The golden seed: a Nix expression / installable spec the warm Job builds into the
        overlay upper (via the sandbox image's nix, landing in `upper/` + registered in
        `state/`). Empty ⇒ a minimal warm (a valid empty upper — the pool then self-enriches
        as conversations install tools and return their PVCs on suspend). This is the ONLY
        knob for "what golden tools to pre-warm".
      '';
    };
    reconcileInterval = mkOption {
      type = types.int;
      default = 10;
      description = "Seconds between reconcile passes (also the Lease renew cadence; < leaseSeconds).";
    };
    leaseSeconds = mkOption {
      type = types.int;
      default = 30;
      description = "Leader-election Lease duration; the holder must renew within this window.";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf wcfg.enable {
    kubernetes.resources = {
      # --- the pool StorageClass (Retain) ---------------------------------
      # WaitForFirstConsumer makes the PV record the topology the predicate reads back.
      storageClasses = lib.mkIf (wcfg.storageProvisioner != null) {
        ${wcfg.storageClass} = {
          metadata.name = wcfg.storageClass;
          provisioner = wcfg.storageProvisioner;
          reclaimPolicy = "Retain";
          volumeBindingMode = "WaitForFirstConsumer";
        };
      };

      # --- SA + RBAC ------------------------------------------------------
      serviceAccounts.warm-store-controller.metadata = {
        name = "warm-store-controller";
        namespace = cfg.namespace;
      };
      roles.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        rules = [
          { apiGroups = [ "" ]; resources = [ "persistentvolumeclaims" ]; verbs = [ "get" "list" "watch" "create" "update" "patch" "delete" ]; }
          # jobs/status is a separate subresource that the marker-check reader polls.
          { apiGroups = [ "batch" ]; resources = [ "jobs" "jobs/status" ]; verbs = [ "get" "list" "watch" "create" "delete" ]; }
          # Sandboxes are read for return/leak signals.
          { apiGroups = [ "agents.x-k8s.io" ]; resources = [ "sandboxes" ]; verbs = [ "get" "list" "watch" ]; }
          # Pods are read to learn which PVCs are currently mounted.
          { apiGroups = [ "" ]; resources = [ "pods" ]; verbs = [ "get" "list" "watch" ]; }
          { apiGroups = [ "coordination.k8s.io" ]; resources = [ "leases" ]; verbs = [ "get" "list" "watch" "create" "update" ]; }
        ];
      };
      # PVs and Nodes are cluster-scoped, beyond the namespaced Role above.
      clusterRoles.warm-store-controller = {
        metadata.name = "warm-store-controller";
        rules = [
          # patch sets/clears claimRef; update is for the ownership finalizer.
          { apiGroups = [ "" ]; resources = [ "persistentvolumes" ]; verbs = [ "get" "list" "watch" "patch" "update" ]; }
          # The predicate matches PV nodeAffinity against node labels.
          { apiGroups = [ "" ]; resources = [ "nodes" ]; verbs = [ "get" "list" "watch" ]; }
        ];
      };
      clusterRoleBindings.warm-store-controller = {
        metadata.name = "warm-store-controller";
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "ClusterRole"; name = "warm-store-controller"; };
        subjects = [{ kind = "ServiceAccount"; name = "warm-store-controller"; namespace = cfg.namespace; }];
      };

      roleBindings.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        roleRef = { apiGroup = "rbac.authorization.k8s.io"; kind = "Role"; name = "warm-store-controller"; };
        subjects = [{ kind = "ServiceAccount"; name = "warm-store-controller"; namespace = cfg.namespace; }];
      };

      # --- the controller Deployment --------------------------------------
      deployments.warm-store-controller = {
        metadata = { name = "warm-store-controller"; namespace = cfg.namespace; };
        spec = {
          replicas = wcfg.replicas;
          selector.matchLabels.app = "warm-store-controller";
          template = {
            metadata.labels.app = "warm-store-controller";
            spec = {
              serviceAccountName = "warm-store-controller";
              containers.controller = {
                name = "controller";
                image = wcfg.image;
                imagePullPolicy = cfg.pullPolicy;
                command = [ "warm-store-controller" ];
                env = [
                  { name = "NAMESPACE"; value = cfg.namespace; }
                  # The controller derives the pool version key from this ref, the same one the provisioner claims by.
                  { name = "SANDBOX_IMAGE"; value = cfg.sandboxImage; }
                  { name = "WARM_STORE_MIN_READY"; value = toString wcfg.minReady; }
                  { name = "WARM_STORE_MAX_TOTAL"; value = toString wcfg.maxTotal; }
                  { name = "WARM_STORE_STORAGE"; value = wcfg.storage; }
                  { name = "WARM_STORE_STORAGE_CLASS"; value = wcfg.storageClass; }
                  { name = "WARM_STORE_GOLDEN_EXPR"; value = wcfg.goldenExpr; }
                ]
                # The warm Job's systemd pod needs the same runtimeClass as the per-conversation sandboxes.
                ++ lib.optional (cfg.sandboxRuntimeClass != null)
                  { name = "SANDBOX_RUNTIME_CLASS"; value = cfg.sandboxRuntimeClass; }
                # The warm Job boots the same image, so it gets the same user-namespace posture.
                ++ lib.optional cfg.sandboxUserNamespace
                  { name = "SANDBOX_USER_NAMESPACE"; value = "1"; }
                ++ [
                  { name = "RECONCILE_INTERVAL_SECONDS"; value = toString wcfg.reconcileInterval; }
                  { name = "LEASE_DURATION_SECONDS"; value = toString wcfg.leaseSeconds; }
                  # The leader-election Lease holder identity.
                  { name = "POD_NAME"; valueFrom.fieldRef.fieldPath = "metadata.name"; }
                ];
                # The kubernetes client alone needs more than a 64Mi request.
                resources = lib.mkDefault {
                  requests = { cpu = "25m"; memory = "128Mi"; };
                  limits = { cpu = "50m"; memory = "256Mi"; };
                };
              };
            };
          };
        };
      };
    };
  })
  ];
}
