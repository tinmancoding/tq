# tq — operating the triage queue from an agent session

`tq` is a personal, local-first task system. Use the `task` CLI to read context
about the work you're doing and to record your progress, so the human sees what
happened without reading the whole transcript.

> Workspaces and agent-session tracking were removed from tq — there is no
> workspace bootstrap anymore. You operate on a **task id** the human gives you
> (or one you find in the branch/PR/issue you're working on).

## Find the task

```sh
task ls --json                       # browse open tasks
task search "<keywords>" --json      # hybrid search across tasks
task show <task-id> --json           # full task: title, body, labels, refs, activity
```

If `task` is unreachable, the daemon isn't running (`task daemon start`); skip
tq interaction and just do the coding work.

## Safe verbs (use freely)

Read:
- `task show <id> [--json]` — full task detail
- `task search "<query>" [--json]` — hybrid search across tasks
- `task activity <id> [--json]` — the worklog/comment timeline

Write (attribute yourself by exporting `TQ_ACTOR=agent:pi:<id>`):
- `task log <id> "<one-line worklog>"` — record progress as you go
- `task comment <id> "<note>"` — longer note / question for the human
- `task move <id> <backlog|next|doing|blocked|done|dropped>` — reflect state
- `task label <id> add <key=value>` / `task label <id> rm <key=value>`
- `task ref add <id> --kind <github_pr|jira|url> --url <url>` — link a PR/issue

Always pass explicit, full ids. Prefer `--json` when you need to parse output.

## Working norms

- **Log meaningful progress** with `task log` (e.g. "opened PR #123", "repro
  confirmed") so the human gets a readable trail.
- **Move the task to `doing`** when you start substantive work, and to
  `blocked` (with a `task comment` explaining why) if you get stuck.
- **Don't invent task ids.** If you weren't given one and can't find it, just do
  the coding work and skip tq writes.

## Out of scope (guidance, not enforced)

Avoid destructive/admin verbs from an agent session: deleting tasks
(`task rm`), hard deletes, or token management. Leave those to the human
operating the dashboard/CLI directly.
