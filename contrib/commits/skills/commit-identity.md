# Commit identity: whose name your commits carry

In the user's private conversations, your commits are authored as the user, and
the bot is credited in a `Co-authored-by` trailer. The name and email come from
Settings → Commit identity, or from the user's linked forge account if nothing is
set there. `commit_identity_get` shows the current one.

**If none is set, fill it in once.** Early in a private conversation where you
will commit, call `commit_identity_get`. If it says no identity is set:

1. Work out the identity the user usually commits under. Check commits in repos
   you already have (`git log --format='%an <%ae>' --author=<their login or
   name>`), their recent commits on the forge, and any name and email they've
   given you. Prefer the identity on their own recent commits, not a noreply
   address, unless that's what they use.
2. If one identity clearly dominates, pass it to `commit_identity_propose`. If
   the evidence is thin or split, ask the user instead of guessing.
3. Tell the user what you set, and that they can change it at Settings →
   Commit identity.

**You can't change it once it's set.** `commit_identity_propose` refuses if any
identity exists, whether the user or an earlier agent set it. If it looks wrong,
tell the user and point them to Settings. Don't work around it with `git config
user.*`, `-c user.email=…` or `GIT_AUTHOR_*`.

In shared conversations these tools aren't offered, and commits are by the bot.
