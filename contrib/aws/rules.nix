# Approval rule sets, toposorted per account into the registry's `approval_rules`.
{ config, lib, ... }:

let
  inherit (lib) mkOption types literalExpression;
  cfg = config;

  dag = import ./lib/dag { inherit lib; };

  # Guards sort before this anchor, grants after it.
  anchor = "grants";

  ruleType = types.submodule {
    options = {
      effect = mkOption {
        type = types.enum [ "allow" "require" "require_always" "deny" ];
        description = ''
          `allow` grants without a human, `require` needs one, `require_always`
          needs this rule's own approvers whatever else matches, and `deny`
          rejects any request that could match it, wherever it sits.
        '';
      };
      actions = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "secretsmanager:GetSecretValue" "*:Get*" ];
        description = "IAM action globs (`*`, `?`), matched per service and verb, case-insensitively.";
      };
      resources = mkOption {
        type = types.listOf types.str;
        default = [ "*" ];
        description = "IAM resource globs the rule applies to.";
      };
      managedPolicyArns = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = "Managed-policy ARN globs, set instead of `actions`.";
      };
      approvers = mkOption {
        type = types.nullOr (types.listOf types.str);
        default = null;
        description = ''
          `require`/`require_always` only: who may approve what this rule
          matches. Replaces the account's approvers; null inherits them.
        '';
      };
    };
  };

  # Rules without edges default to their side of the anchor.
  placed = e:
    if e.before != [ ] || e.after != [ ] then e
    else if e.data.effect == "allow" then e // { after = [ anchor ]; }
    else e // { before = [ anchor ]; };

  # Bare edge names refer to a sibling in the same set.
  qualify = prefix: siblings: e:
    let q = n: if n == anchor || lib.hasInfix "/" n || !(siblings ? ${n}) then n else "${prefix}/${n}";
    in e // { before = map q e.before; after = map q e.after; };

  namespaced = prefix: entries:
    lib.mapAttrs' (n: e: lib.nameValuePair "${prefix}/${n}" (qualify prefix entries (placed e))) entries;

  normList = v: if builtins.isList v then v else [ v ];

  # The deprecated auto_allowed_* keys, as allow rules.
  legacyRules = alias: a:
    let
      stmts = (a.auto_allowed_policy or { }).Statement or [ ];
      arns = a.auto_allowed_managed_policies or [ ];
    in
    lib.listToAttrs (lib.imap0 (i: s: lib.nameValuePair "legacy/auto-allowed-${toString i}" {
      data = {
        effect = "allow";
        actions = normList (s.Action or [ ]);
        resources = normList (s.Resource or [ "*" ]);
        managedPolicyArns = [ ];
        approvers = null;
      };
      before = [ ];
      after = [ anchor ];
    }) stmts)
    // lib.optionalAttrs (arns != [ ]) {
      "legacy/auto-allowed-managed" = {
        data = { effect = "allow"; actions = [ ]; resources = [ "*" ]; managedPolicyArns = arns; approvers = null; };
        before = [ ];
        after = [ anchor ];
      };
    };

  hasLegacy = a: a ? auto_approve_read_only || a ? auto_allowed_policy || a ? auto_allowed_managed_policies;

  checkRule = alias: name: r:
    let where = "contribs.aws: account '${alias}', rule '${name}'"; in
    if (r.actions == [ ]) == (r.managedPolicyArns == [ ]) then
      throw "${where}: set exactly one of `actions` and `managedPolicyArns`"
    else if r.approvers != null && !(builtins.elem r.effect [ "require" "require_always" ]) then
      throw "${where}: `approvers` only applies to require and require_always rules"
    else r;

  # Selected sets plus the account's own rules, toposorted.
  compile = alias: a:
    let
      skipped = a.skipDefaultRuleSets;
      setNames = lib.unique (
        lib.filter (s: !(builtins.elem s skipped)) cfg.defaultRuleSets
        ++ a.ruleSets
        ++ lib.optional (a.auto_approve_read_only or false) "read-only"
      );
      missing = lib.filter (s: !(cfg.ruleSets ? ${s})) setNames;
      graph =
        lib.foldl' (acc: s: acc // namespaced s cfg.ruleSets.${s}) { } setNames
        // namespaced "account" a.rules
        // legacyRules alias a
        // { ${anchor} = dag.entryAnywhere null; };
      sorted = dag.topoSort graph;
    in
    if builtins.elem "blocked" skipped then
      throw "contribs.aws: account '${alias}' can't skip the `blocked` rule set"
    else if missing != [ ] then
      throw "contribs.aws: account '${alias}' names unknown rule sets: ${toString missing}"
    else if !(sorted ? result) then
      throw "contribs.aws: account '${alias}' has an approval-rule cycle through: ${toString (map (e: e.name) sorted.cycle)}"
    else {
      inherit setNames;
      rules = map (e:
        if e.name == anchor then { name = anchor; anchor = true; }
        else let r = checkRule alias e.name e.data; in {
          inherit (e) name;
          inherit (r) effect actions resources approvers;
          managed_policy_arns = r.managedPolicyArns;
        }) sorted.result;
    };

  render = alias: a:
    let
      c = compile alias a;
      acct = builtins.removeAttrs a [
        "ruleSets" "skipDefaultRuleSets" "rules" "auto_allowed_policy" "auto_allowed_managed_policies"
      ];
      warn = if hasLegacy a then lib.warn
        "contribs.aws: account '${alias}' uses auto_approve_read_only / auto_allowed_*; use ruleSets and rules instead."
        else x: x;
    in
    warn (acct // {
      approvers = if a.approvers != [ ] then a.approvers else cfg.defaultApprovers;
      approval_rules = c.rules;
      # Reported to the agent by `scooter-aws accounts`.
      auto_approve_read_only = builtins.elem "read-only" c.setNames;
    });

  accountType = types.submodule {
    freeformType = types.attrsOf types.anything;
    options = {
      ruleSets = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "read-only" ];
        description = "Rule sets this account uses on top of `defaultRuleSets`. Their order doesn't matter; the DAG's does.";
      };
      skipDefaultRuleSets = mkOption {
        type = types.listOf types.str;
        default = [ ];
        example = [ "secrets-guard" ];
        description = "Entries of `defaultRuleSets` this account opts out of. `blocked` can't be skipped.";
      };
      rules = mkOption {
        type = dag.dagOf ruleType;
        default = { };
        description = "This account's own rules, named `account/<name>` in the merged graph.";
      };
      approvers = mkOption {
        type = types.listOf types.str;
        default = [ ];
        description = ''
          Who may approve this account's requests (seeded into OpenFGA when
          scooter.broker.fga.enable is set). Empty falls back to `defaultApprovers`.
        '';
      };
    };
  };
in
{
  options = {
    dag = mkOption {
      type = types.raw;
      readOnly = true;
      default = dag // {
        allow = data: dag.entryAfter [ anchor ] (data // { effect = "allow"; });
        require = data: dag.entryBefore [ anchor ] (data // { effect = "require"; });
      };
      defaultText = literalExpression "the vendored denful/dag API plus allow/require";
      description = ''
        DAG helpers for writing rules: `entryBefore`, `entryAfter`,
        `entryBetween`, and `allow`/`require`, which place a rule after/before
        the `grants` anchor. A rule written as a plain attrset gets the same
        placement from its effect.
      '';
    };

    ruleSets = mkOption {
      type = types.attrsOf (dag.dagOf ruleType);
      default = { };
      description = ''
        Named approval rule sets. Each is a DAG of rules; entries are named
        `<set>/<entry>` when composed, so edges can name other sets' entries
        (dangling edges are ignored). The walk collects every `require` rule a
        request overlaps and stops at the first `allow` that covers it; `deny`
        and `require_always` rules apply wherever they sit. Ships `blocked`,
        `secrets-guard`, `read-only` and `kms-decrypt`.
      '';
      example = literalExpression ''
        {
          dev-secrets.dev-secret-values = config.contribs.aws.dag.entryBefore [ "secrets-guard/secret-values" ] {
            effect = "allow";
            actions = [ "secretsmanager:GetSecretValue" ];
            resources = [ "arn:aws:secretsmanager:*:*:secret:dev/*" ];
          };
        }
      '';
    };

    defaultRuleSets = mkOption {
      type = types.listOf types.str;
      default = [ "blocked" "secrets-guard" ];
      description = "Rule sets every account uses unless it lists them in `skipDefaultRuleSets`.";
    };

    defaultApprovers = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = "Approvers for accounts that set none.";
    };

    accounts = mkOption {
      type = types.attrsOf accountType;
      default = { };
      description = ''
        The account registry: alias -> { account_id, broker_role_arn, enabled,
        description?, allowed_policy?, allowed_managed_policies?, region?,
        approvers?, ruleSets?, skipDefaultRuleSets?, rules? }. Rendered, with
        each account's compiled `approval_rules`, into a ConfigMap mounted at
        /etc/agent-broker/accounts.json.

        `description` is a human-written summary of what the account is for. The
        agent reads it (via `scooter-aws accounts`) to pick the RIGHT account to
        request access to, so set it on every account.

        `allowed_policy` is the ceiling: a request outside it is rejected. Within
        it, the approval rules decide whether a human must approve. The
        `blocked` and `secrets-guard` sets apply by default; add `read-only` to
        grant read-only requests without a human.

        The old `auto_approve_read_only`, `auto_allowed_policy` and
        `auto_allowed_managed_policies` keys still work, with a warning: they
        become the `read-only` set and `legacy/*` allow rules.
      '';
      example = literalExpression ''
        {
          readonly-sandbox = {
            account_id = "123456789012";
            broker_role_arn = "arn:aws:iam::123456789012:role/agent-token-broker-base";
            enabled = true;
            description = "Sandbox account for safe read-only exploration (S3, logs).";
            ruleSets = [ "read-only" ];
          };
        }
      '';
    };

    renderedAccounts = mkOption {
      type = types.raw;
      readOnly = true;
      internal = true;
      visible = false;
      default = lib.mapAttrs render cfg.accounts;
      defaultText = literalExpression "accounts with their compiled approval_rules";
      description = "The registry as written to accounts.json.";
    };
  };

  config.ruleSets = {
    blocked = {
      iam-escalation = { effect = "deny"; actions = [
        "iam:CreateUser" "iam:CreateRole" "iam:AttachRolePolicy" "iam:DetachRolePolicy"
        "iam:PutRolePolicy" "iam:DeleteRolePolicy" "iam:CreateAccessKey"
        "iam:UpdateAssumeRolePolicy" "iam:PutRolePermissionsBoundary"
        "iam:DeleteRolePermissionsBoundary" "iam:PassRole"
      ]; };
      audit-tampering = { effect = "deny"; actions = [
        "cloudtrail:DeleteTrail" "cloudtrail:StopLogging" "cloudtrail:UpdateTrail"
        "guardduty:Delete*" "guardduty:Disable*" "guardduty:DisassociateFromMasterAccount"
        "securityhub:Delete*" "securityhub:Disable*" "config:Delete*" "config:Stop*"
      ]; };
      organization = { effect = "deny"; actions = [ "organizations:LeaveOrganization" "account:CloseAccount" ]; };
      encryption = { effect = "deny"; actions = [ "kms:ScheduleKeyDeletion" "kms:DisableKey" "kms:Delete*" ]; };
    };

    secrets-guard = {
      secret-values = { effect = "require"; actions = [ "secretsmanager:GetSecretValue" "secretsmanager:BatchGetSecretValue" ]; };
      ssm-params = { effect = "require"; actions = [ "ssm:GetParameter" "ssm:GetParameters" "ssm:GetParametersByPath" ]; };
      kms-decrypt = { effect = "require"; actions = [ "kms:Decrypt" ]; };
    };

    # Opt-in carve-back for deployments that find the guard noisy.
    kms-decrypt.allow-decrypt = dag.entryBefore [ "secrets-guard/kms-decrypt" ] {
      effect = "allow";
      actions = [ "kms:Decrypt" ];
    };

    read-only = lib.listToAttrs (map (verb: lib.nameValuePair (lib.toLower verb) {
      effect = "allow";
      actions = [ "*:${verb}*" ];
    }) [
      "Get" "List" "Describe" "Head" "BatchGet" "Lookup" "Search" "Query" "Scan" "Select"
      "Check" "Detect" "Discover" "Fetch" "Preview" "Read" "Test" "Validate" "Verify"
    ]);
  };
}
