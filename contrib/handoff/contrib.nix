# handoff's declaration: agents spawn new conversations, recall shared ones, and pass
# file bundles between sandboxes. Its deployment half (./deployment.nix) lets the broker
# spawn through the router.
{ lib, ... }:

{
  contribs.handoff = { config, ... }: {
    options = {
      publicBaseUrl = lib.mkOption {
        type = lib.types.str;
        default = "";
        example = "https://scooter.example.com";
        description = ''
          UI origin for the conversation links a handoff returns and attaches
          (HANDOFF_PUBLIC_BASE_URL). Empty -> https://<ingress.host> when that is
          set, else links carry the bare conversation id.
        '';
      };
      maxBundleBytes = lib.mkOption {
        type = lib.types.ints.positive;
        default = 1024 * 1024 * 1024;
        description = "Largest bundle one upload may store (HANDOFF_MAX_BUNDLE_BYTES).";
      };
      sandboxQuotaBytes = lib.mkOption {
        type = lib.types.ints.positive;
        default = 5 * 1024 * 1024 * 1024;
        description = ''
          Live bundle bytes one sandbox may hold at once (HANDOFF_SANDBOX_QUOTA_BYTES).
          Bundles are Postgres rows, so this and the TTL bound the database's growth.
        '';
      };
      bundleTtlDays = lib.mkOption {
        type = lib.types.ints.positive;
        default = 14;
        description = "Days a bundle lives after its last upload or download (HANDOFF_BUNDLE_TTL_DAYS).";
      };
      indexEvery = lib.mkOption {
        type = lib.types.str;
        default = "5m";
        description = "How often the index task folds new shared-conversation activity into search.";
      };
    };

    config = {
      src = ./.;

      # Its own database (contrib_handoff).
      db = {
        enable = true;
        tables.handoff_bundles = { };
        tables.handoff_bundle_chunks = { };
        tables.handoff_conversations = { };
        tables.handoff_messages = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env = {
          HANDOFF_ENABLED = "true";
          HANDOFF_MAX_BUNDLE_BYTES = toString config.maxBundleBytes;
          HANDOFF_SANDBOX_QUOTA_BYTES = toString config.sandboxQuotaBytes;
          HANDOFF_BUNDLE_TTL_DAYS = toString config.bundleTtlDays;
        };
      };

      skills."scooter-handoff.md" = ./skills/scooter-handoff.md;

      ui.source = { label = "Handoff"; icon = ./icon.svg; };

      # Mapped in as scooter.systemTasks.handoff-index only while this contrib is enabled.
      systemTasks.index = {
        entry = "scooter_contrib_handoff.tasks:main";
        every = config.indexEvery;
        timeout = "4m";
      };
    };
  };
}
