# UI metadata

A contrib can describe how it appears in the chat UI: the brand label, icon and color on
its linked resources, and how its tool calls render as cards in the message stream. It's
declared in `contrib.nix`. You don't write any React.

```nix
# contrib/acme/contrib.nix
config.ui = {
  # How links with source = "acme" look in the conversation's links panel.
  source = {
    label = "Acme";
    icon = ./icon.svg;          # in the contrib's directory
    color = "#E5484D";          # or "currentColor"
    linkProvider = true;        # offer an "Acme" filter chip in the sidebar
  };

  # How a call to the acme_comment tool renders.
  tools.acme_comment = {
    argKey = "body";            # the argument the card shows
    action = "commented on Acme";
  };
};
```

- **`source`** applies to links whose `source` is your contrib's name, both those created
  by [link rules](broker.md#linking-created-resources) and those your
  [webhook handler](webhooks.md) pushes.
- **`tools.<name>`** turns a tool call into a readable card ("Scooter commented on Acme",
  with the comment text) instead of raw JSON arguments.

## The icon

The icon must be an SVG with **one `<path>`** and a `viewBox`. Scooter reads those two
attributes out of the file and ships them as data. [Simple Icons](https://simpleicons.org)
(CC0) has single-path marks for most products.

## How it reaches the browser

The UI image is built once and used by every deployment, so the metadata isn't compiled
in. The platform renders the enabled contribs' metadata into one JSON file, which is
served at `/contrib/manifest.json` and merged by the UI on load. Enabling or disabling a
contrib changes that file, not the UI bundle.

To see your rows in local UI development:

```bash
nix build .#contrib-ui-manifest
mkdir -p ui/public/contrib && cp result ui/public/contrib/manifest.json
```

`ui/public/contrib/` is gitignored, so don't commit the copy.

Next: [testing and shipping](testing.md).
