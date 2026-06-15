# tq — operating the triage queue from an agent session

You are running inside a **tq workspace** (a tasktree). tq is a personal,
local-first task system. Each task can own exactly one workspace (this
directory), and every pi session that runs here is collected against that task.
Use the `task` CLI to read context and record your work.

## Bootstrap: find your task at session start

This workspace is annotated with its task id. Read it, then load the task:

```sh
# tasktree-backed workspace:
tasktree -C . annotate list        # look for the `tq.task-id` row
# or a local workspace marker:
cat .tq.json                       # { "tq.task-id": "…" }

task show <task-id> --json         # full task: title, body, labels, refs, activity
```

If `task` is unreachable, the daemon isn't running (`task daemon start`); skip
tq interaction and proceed with the coding work.

## Safe verbs (use freely)

Read:
- `task show <id> [--json]` — full task detail
- `task search "<query>" [--json]` — hybrid search across tasks
- `task activity <id> [--json]` — the worklog/comment timeline
- `task session ls <id> [--json]` — sessions recorded in this workspace

Write (attributed to you as `agent:pi:<id>` via `TQ_ACTOR`):
- `task log <id> "<one-line worklog>"` — record progress as you go
- `task comment <id> "<note>"` — longer note / question for the human
- `task move <id> <backlog|next|doing|blocked|done|dropped>` — reflect state
- `task label <id> add <key=value>` / `task label <id> rm <key=value>`
- `task ref add <id> --kind <github_pr|jira|url> --url <url>` — link a PR/issue

Always pass explicit, full ids. Prefer `--json` when you need to parse output.

## Working norms

- **Log meaningful progress** with `task log` so the human sees what happened
  without reading the whole transcript (e.g. "opened PR #123", "repro confirmed").
- **Move the task to `doing`** when you start substantive work, and to
  `blocked` (with a `task comment` explaining why) if you get stuck.
- **Don't invent task ids.** If the bootstrap step finds no `tq.task-id`, just
  do the coding work and skip tq writes.

## Out of scope (guidance, not enforced)

Avoid destructive/admin verbs from an agent session: deleting tasks
(`task rm`), hard deletes, detaching workspaces, or token management. Leave
those to the human operating the dashboard/CLI directly.
