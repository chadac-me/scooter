# Stop hook: send the agent back once over unfinished work.
set -u
input=$(cat)

# One reminder per turn; a second stop is the agent's call.
[ "$(jq -r '.stop_hook_active // false' <<<"$input")" = true ] && exit 0
last=$(jq -r '.last_assistant_message // ""' <<<"$input")
provider=$(jq -r '.scooter.provider // ""' <<<"$input")
# A subagent shares its parent's sandbox; the parent owns finishing.
[ "$(jq -r '.scooter.parent_id // ""' <<<"$input")" = "" ] || exit 0

root=${CLAUDE_PROJECT_DIR:-/workspace}
problems=()
for gitdir in "$root"/.git "$root"/*/.git; do
  [ -e "$gitdir" ] || continue
  repo=$(dirname "$gitdir")
  name=${repo#"$root"/}
  [ "$repo" = "$root" ] && name=$(basename "$root")
  branch=$(git -C "$repo" symbolic-ref --quiet --short HEAD 2>/dev/null) || continue
  base=$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || continue
  # The default branch is never waiting on a PR.
  [ "$branch" = "${base#origin/}" ] && continue
  if [ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]; then
    problems+=("$name: uncommitted changes on $branch")
    continue
  fi
  [ "$(git -C "$repo" rev-list --count "$base..HEAD" 2>/dev/null || echo 0)" -gt 0 ] || continue
  if ! upstream=$(git -C "$repo" rev-parse --abbrev-ref '@{upstream}' 2>/dev/null); then
    problems+=("$name: $branch has commits but was never pushed")
    continue
  fi
  ahead=$(git -C "$repo" rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)
  if [ "$ahead" -gt 0 ]; then
    problems+=("$name: $ahead unpushed commit(s) on $branch")
    continue
  fi
  # Only a definite "no PR" counts; gh errors say nothing.
  if command -v gh >/dev/null; then
    err=$(cd "$repo" && timeout 10 gh pr view "$branch" --json state 2>&1 >/dev/null) ||
      case "$err" in *"no pull requests found"*) problems+=("$name: $branch is pushed but has no PR") ;; esac
  fi
done

# Does the reply's last line, minus markdown, ask something?
tail_line=$(printf '%s\n' "$last" | sed -e 's/[[:space:]*_`)]*$//' | awk 'NF { l = $0 } END { print l }')
asks=false
case "$tail_line" in *\?) asks=true ;; esac

[ ${#problems[@]} -eq 0 ] && [ "$asks" = false ] && exit 0

reason=""
if [ ${#problems[@]} -gt 0 ]; then
  reason="Before you stop, this work is unfinished:"
  for p in "${problems[@]}"; do reason+=$'\n'"- $p"; done
  reason+=$'\n\n'"You are pre-authorized to commit, push your branch and open or update its PR, so do that now. If you are leaving it on purpose (waiting on the user's review, or they asked you not to push), say so in one line and end your turn."
fi
if [ "$asks" = true ]; then
  [ -n "$reason" ] && reason+=$'\n\n'
  if [ "$provider" = claude ]; then
    how="ask with the AskUserQuestion tool so they get a real prompt"
  else
    how="end with that one question, stated plainly"
  fi
  reason+="Your reply ends with a question. If the user's request already answers it (\"should I open the PR?\", \"want me to continue?\"), don't ask: do it. If you truly need their decision, $how."
fi
jq -n --arg reason "$reason" '{decision: "block", reason: $reason}'
