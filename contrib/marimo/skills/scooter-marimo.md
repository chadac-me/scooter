---
name: scooter-marimo
description: >-
  marimo notebooks in this sandbox: the `marimo` web service and how to pair on it
  with the marimo-pair skill. Use when the user wants a notebook, data exploration,
  plots or an interactive report, or asks you to work in their open notebook.
---

# marimo in Scooter

Your sandbox can serve a **marimo notebook** to the user as the `marimo` web
service, and you can drive that same notebook yourself with the **marimo-pair**
skill: run code in its kernel, read live variables, and add, edit and run cells.
The user watches and edits in their browser at the same time.

Reach for it when seeing beats telling: exploring data, plotting, or a computed
report the user can poke at. Don't start one for a quick calculation; use your
shell for that.

## 1. Start it and give the user the link

```bash
scooter-service start marimo     # prints the notebook's URL
scooter-service start notebook   # "marimo + chat": this conversation beside the notebook
```

Give the user the **notebook** link (`marimo + chat`) by default. It shows this
conversation on the left and marimo on the right, so they can ask you for changes
without leaving the notebook. The marimo link alone is for a full-screen notebook.
The user can also start either from the **Services panel**. The first start
materializes marimo, which takes a while. Notebooks live in `/workspace`.

**marimo-pair can only reach a notebook the user has open in the browser.** A
session exists only while a tab has the notebook open. So ask the user to open
the link, and to create or pick a notebook, before you pair.

## 2. Pair with marimo-pair

Read the **marimo-pair** skill and follow it. Two things differ here:

- **Pass `--url` explicitly.** Our server runs headless under a base path, so
  `discover-servers.sh` won't find it. Use:

  ```bash
  # marimo serves at /marimo on the conversation's own origin, else under /c/<id>/marimo.
  MARIMO_BASE=${SCOOTER_SERVICES_ORIGIN:+/marimo}; MARIMO_BASE=${MARIMO_BASE:-/c/$CONVERSATION_ID/marimo}
  bash /etc/scooter/skills/marimo-pair/scripts/execute-code.sh \
    --url "http://localhost:2718$MARIMO_BASE" \
    -c "import marimo._code_mode as cm; help(cm)"
  ```

  With several notebooks open, add `--file <notebook.py>`.
- **Its scripts are in your sandbox** at `/etc/scooter/skills/marimo-pair`.
  `curl` and `jq` are on PATH.

marimo-pair's rules hold as written:
- Don't edit the `.py` file while a session is running.
- Make notebook changes through `marimo._code_mode`.
- Add packages with `ctx.packages.add()` (next section).

## 3. Packages: each notebook has its own environment

A notebook's dependencies are its inline (PEP 723) header, and marimo builds the
notebook's own environment from it. That environment is not your shell's Python.
**Never create a `pyproject.toml`, `requirements.txt` or venv for a notebook, and
never `pip install` for one.** None of these reach it.

- **The notebook is open:** add packages through marimo-pair, then re-run the cells
  that need them. Adding a package doesn't re-run anything.

  ```python
  async with cm.get_context() as ctx:
      ctx.packages.add("polars", "altair")   # or ctx.packages.remove(...)
  ```

  It installs into the running kernel and pins the version in the header. Don't edit
  the header on disk instead: the open kernel ignores it until it restarts.
- **"restart the kernel to use them":** ask the user before restarting. A restart
  loses everything the notebook holds in memory.
- **A new notebook nobody has open yet:** write the header when you create the file.

  ```python
  # /// script
  # requires-python = ">=3.12"
  # dependencies = ["marimo", "polars"]
  # ///
  ```
- **Not a Python package** (a CLI tool, or a C library a wheel needs): it comes from
  Nix. Add it with a module under `/etc/scooter/modules/` (the scooter-env skill).
- Leave `~/.cache/uv/environments-v2/` alone; marimo owns it.

## 4. Settings

marimo's settings are in `~/.config/marimo/marimo.toml`, on the workspace volume.
The marimo settings panel writes the same file, so the user and you share it. marimo
reads it whenever a notebook opens, so changes need no restart.

- Notebooks **run when opened** (`runtime.auto_instantiate = true`), so a bookmark
  that wakes the sandbox lands on a computed notebook. Leave that on unless the user
  asks otherwise.
- **Never put marimo settings in a `pyproject.toml`.** The server only reads
  `/workspace/pyproject.toml`, never one beside a notebook, and creating that one
  makes the whole workspace a uv project.

## If something is off

- `scooter-service status marimo` and `journalctl -u webservice-marimo -n 50`
  show the server's state and log.
- "Failed to connect": the service isn't running, or the URL lacks marimo's base
  path (`$MARIMO_BASE` above).
- "No sessions": nobody has the notebook open. Ask the user to open the link.
