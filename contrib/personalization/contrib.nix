# personalization's declaration: a per-user profile of notes, refreshed by a system
# task, read by agents through a tool and edited on a settings tab.
{ lib, ... }:

{
  contribs.personalization = { config, ... }: {
    options = {
      refreshInterval = lib.mkOption {
        type = lib.types.strMatching "[0-9]+[hd]";
        default = "10d";
        description = "How long after a user's last analysis they are due again.";
      };
      maxSpawnsPerRun = lib.mkOption {
        type = lib.types.ints.positive;
        default = 25;
        description = "At most this many analysis conversations per hourly run; the rest wait an hour.";
      };
    };

    config = {
      src = ./.;

      # Its own database (contrib_personalization), so its Atlas history in ./sql is its own.
      db = {
        enable = true;
        tables.personalization_profiles = { };
        tables.personalization_notes = { };
      };

      services.broker = {
        enable = true;
        pythonDeps = ps: [ ps.aiosqlite ];
        env.PERSONALIZATION_ENABLED = "true";
      };

      skills."personalization.md" = ./skills/personalization.md;

      ui.settingsTabs = [{
        label = "Personalization";
        order = 45;
        entry = "ui/SettingsTab.tsx";
        api = true;
      }];

      # Mapped in as scooter.systemTasks.personalization-refresh-profile only while this
      # contrib is enabled.
      systemTasks.refresh-profile = {
        entry = "scooter_contrib_personalization.tasks.refresh:main";
        args = [
          "--prompt-file" "${./prompts/refresh.md}"
          "--interval" config.refreshInterval
          "--max-spawns" (toString config.maxSpawnsPerRun)
        ];
        every = "1h";
        timeout = "10m";
      };
    };
  };
}
