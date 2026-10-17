# assets

Images for Scooter's README and docs, kept off `main` so they don't grow its history.

This branch shares no history with `main`. Link to files from the README with raw URLs:

```markdown
![Scooter](https://raw.githubusercontent.com/chadac/scooter/assets/readme/screenshot.png)
```

Add or replace a file:

```bash
git fetch origin assets
git worktree add ../scooter-assets assets
cp ~/screenshot.png ../scooter-assets/readme/
git -C ../scooter-assets add readme && git -C ../scooter-assets commit -m "readme: update screenshot"
git -C ../scooter-assets push origin assets
```

To replace an image, give the new file a new name (`screenshot-v2.png`) and update the link,
so browsers and GitHub's image cache don't keep showing the old one.
