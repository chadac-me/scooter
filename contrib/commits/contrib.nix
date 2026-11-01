# commits' declaration: the name and email a user's commits carry. The user sets it
# on a settings tab; an agent may fill it in once, in their private conversation.
{ ... }:

{
  contribs.commits = {
    src = ./.;

    # Its own database, contrib_commits, with its own Atlas history.
    db = {
      enable = true;
      tables.commit_identities = { };
    };

    services.broker = {
      enable = true;
      pythonDeps = ps: [ ps.aiosqlite ];
      env.COMMITS_ENABLED = "true";
    };

    skills."commit-identity.md" = ./skills/commit-identity.md;

    ui.settingsTabs = [{
      label = "Commit identity";
      order = 48;
      entry = "ui/SettingsTab.tsx";
      api = true;
    }];
  };
}
