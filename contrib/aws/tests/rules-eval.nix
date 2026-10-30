# Eval tests for rules.nix; builds an empty file when all pass.
{ pkgs, lib }:

let
  eval = cfg: (lib.evalModules {
    specialArgs = { inherit lib; };
    modules = [ ../../spec.nix ../contrib.nix { contribs.aws = cfg; } ];
  }).config.contribs.aws.renderedAccounts;

  names = acct: map (r: r.name) acct.approval_rules;
  before = acct: a: b: lib.lists.findFirstIndex (n: n == a) null (names acct)
    < lib.lists.findFirstIndex (n: n == b) null (names acct);
  fails = cfg: !(builtins.tryEval (builtins.deepSeq (eval cfg) true)).success;

  r = eval ({ config, ... }: {
    defaultApprovers = [ "admin@x" ];
    ruleSets.dev-secrets.dev = config.dag.entryBefore [ "secrets-guard/secret-values" ] {
      effect = "allow";
      actions = [ "secretsmanager:GetSecretValue" ];
      resources = [ "arn:aws:secretsmanager:*:*:secret:dev/*" ];
    };
    # Extending a shipped set by module merging.
    ruleSets.read-only.athena = config.dag.allow { actions = [ "athena:GetQueryResults" ]; };
    accounts = {
      prod = {
        approvers = [ "oncall@x" ];
        ruleSets = [ "read-only" ];
        rules.customer-data = { effect = "require"; actions = [ "s3:GetObject" ]; approvers = [ "data@x" ]; };
      };
      dev = { ruleSets = [ "dev-secrets" "read-only" ]; skipDefaultRuleSets = [ "secrets-guard" ]; };
      kms = { ruleSets = [ "kms-decrypt" ]; };
      legacy = {
        auto_approve_read_only = true;
        auto_allowed_policy.Statement = [ { Action = "sts:AssumeRole"; Resource = "arn:aws:iam::1:role/deploy-*"; } ];
        auto_allowed_managed_policies = [ "arn:aws:iam::aws:policy/ReadOnly*" ];
      };
    };
  });
  rule = acct: n: lib.findFirst (x: x.name == n) null acct.approval_rules;

  cases = {
    "defaults are on every account" = lib.all (a: builtins.elem "blocked/encryption" (names a) && a ? approval_rules) (builtins.attrValues r);
    "guards sort before grants, grants before allows" =
      before r.prod "secrets-guard/secret-values" "grants" && before r.prod "grants" "read-only/get";
    "account rules are namespaced and guard by default" = before r.prod "account/customer-data" "grants";
    "rule approvers pass through" = (rule r.prod "account/customer-data").approvers == [ "data@x" ];
    "account approvers fall back to defaultApprovers" = r.prod.approvers == [ "oncall@x" ] && r.dev.approvers == [ "admin@x" ];
    "skipDefaultRuleSets drops a default set" = !(builtins.elem "secrets-guard/secret-values" (names r.dev));
    "a dangling edge is ignored" = builtins.elem "dev-secrets/dev" (names r.dev);
    "a shipped set can be extended" = builtins.elem "read-only/athena" (names r.prod);
    "the kms carve-back sorts before its guard" = before r.kms "kms-decrypt/allow-decrypt" "secrets-guard/kms-decrypt";
    "auto_approve_read_only reports the read-only set" = r.prod.auto_approve_read_only && !r.kms.auto_approve_read_only;
    "legacy keys become the read-only set and allow rules" =
      builtins.elem "read-only/get" (names r.legacy)
      && (rule r.legacy "legacy/auto-allowed-0").resources == [ "arn:aws:iam::1:role/deploy-*" ]
      && (rule r.legacy "legacy/auto-allowed-managed").managed_policy_arns == [ "arn:aws:iam::aws:policy/ReadOnly*" ]
      && !(r.legacy ? auto_allowed_policy);
    "Nix-only keys are not rendered" = !(r.prod ? ruleSets || r.prod ? rules || r.prod ? skipDefaultRuleSets);

    "skipping blocked fails" = fails { accounts.a.skipDefaultRuleSets = [ "blocked" ]; };
    "an unknown rule set fails" = fails { accounts.a.ruleSets = [ "nope" ]; };
    "approvers on an allow rule fail" = fails { accounts.a.rules.x = { effect = "allow"; actions = [ "a:b" ]; approvers = [ "z" ]; }; };
    "an IAM-only key fails" = fails { accounts.a.rules.x = { effect = "allow"; NotAction = [ "a:b" ]; }; };
    "a rule with no actions fails" = fails { accounts.a.rules.x.effect = "require"; };
    "a cycle fails" = fails ({ config, ... }: {
      accounts.a.rules = {
        x = config.dag.entryBefore [ "y" ] { effect = "require"; actions = [ "a:b" ]; };
        y = config.dag.entryBefore [ "x" ] { effect = "require"; actions = [ "a:b" ]; };
      };
    });
  };

  failed = lib.attrNames (lib.filterAttrs (_: ok: !ok) cases);
in
if failed != [ ] then throw "contrib/aws rules-eval failed: ${lib.concatStringsSep "; " failed}"
else pkgs.writeText "contrib-aws-rules-eval" ""
