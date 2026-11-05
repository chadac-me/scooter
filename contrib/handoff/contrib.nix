# handoff's declaration: agents spawn new conversations and recall shared ones.
# Its deployment half (./deployment.nix) lets the broker
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
        tables.handoff_conversations = { };
        tables.handoff_messages = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env.HANDOFF_ENABLED = "true";
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
