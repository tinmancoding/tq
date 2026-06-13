#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { Client, CliError, EXIT } from "./client.js";
import {
  emit,
  parseLabelArg,
  printIntakeList,
  printTask,
  printTaskList,
  shortId,
} from "./output.js";
import { daemonStart, daemonStop, daemonStatus, daemonLogs } from "./daemon-control.js";

const program = new Command();
program
  .name("task")
  .description("tq — triage queue: capture, triage, and manage tasks")
  .version("0.1.0");

const client = (): Client => new Client();

// ─────────────────────────────── tasks ────────────────────────────────
program
  .command("add")
  .description("create a task")
  .argument("<title>", "task title")
  .option("--body <text>", "markdown body")
  .option("--label <k=v>", "label (repeatable)", collect, [])
  .option("--priority <p>", "high|med|low")
  .option("--due <date>", "ISO date")
  .option("--json", "json output")
  .action(async (title, opts) => {
    const task = await client().post("/api/tasks", {
      title,
      body: opts.body,
      priority: opts.priority,
      due_at: opts.due,
      labels: (opts.label as string[]).map(parseLabelArg),
    });
    opts.json ? emit(task, true) : printTask(task as never);
  });

program
  .command("ls")
  .description("list tasks")
  .option("--status <s>")
  .option("--label <k=v>")
  .option("--json")
  .action(async (opts) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    if (opts.label) qs.set("label", normalizeLabel(opts.label));
    const res = await client().get<{ tasks: unknown[] }>(`/api/tasks?${qs}`);
    opts.json ? emit(res.tasks, true) : printTaskList(res.tasks as never);
  });

program
  .command("show")
  .description("show a task")
  .argument("<id>")
  .option("--json")
  .action(async (id, opts) => {
    const task = await client().get(`/api/tasks/${id}`);
    if (opts.json) return emit(task, true);
    printTaskDetail(task);
  });

program
  .command("edit")
  .description("edit task fields")
  .argument("<id>")
  .option("--title <t>")
  .option("--body <b>")
  .option("--priority <p>")
  .option("--due <d>")
  .option("--snooze <d>")
  .option("--json")
  .action(async (id, opts) => {
    const task = await client().patch(`/api/tasks/${id}`, {
      title: opts.title,
      body: opts.body,
      priority: opts.priority,
      due_at: opts.due,
      snooze_until: opts.snooze,
    });
    opts.json ? emit(task, true) : printTask(task as never);
  });

program
  .command("move")
  .description("change task status")
  .argument("<id>")
  .argument("<status>", "backlog|next|doing|blocked|done|dropped")
  .option("--json")
  .action(async (id, status, opts) => {
    const task = await client().post(`/api/tasks/${id}/move`, { status });
    opts.json ? emit(task, true) : printTask(task as never);
  });

program
  .command("label")
  .description("add/remove a label")
  .argument("<id>")
  .argument("<op>", "add|rm")
  .argument("<label>", "key=value")
  .action(async (id, op, label) => {
    const { key, value } = parseLabelArg(label);
    if (op === "add") {
      await client().post(`/api/tasks/${id}/labels`, { key, value });
    } else if (op === "rm") {
      await client().del(`/api/tasks/${id}/labels/${encodeURIComponent(key)}/${encodeURIComponent(value)}`);
    } else {
      throw new CliError(`unknown op "${op}" (add|rm)`, EXIT.validation);
    }
    process.stdout.write(`ok\n`);
  });

const ref = program.command("ref").description("manage external refs");
ref
  .command("add")
  .argument("<id>")
  .requiredOption("--kind <kind>", "github_pr|jira|url|...")
  .requiredOption("--url <url>")
  .option("--external-id <id>")
  .option("--title <t>")
  .action(async (id, opts) => {
    const r = await client().post(`/api/tasks/${id}/refs`, {
      kind: opts.kind,
      url: opts.url,
      external_id: opts.externalId,
      title: opts.title,
    });
    emit(r, true);
  });

program
  .command("log")
  .description("append a worklog one-liner")
  .argument("<id>")
  .argument("<message>")
  .action(async (id, message) => {
    await client().post(`/api/tasks/${id}/activity`, { entry_type: "worklog", body: message });
    process.stdout.write(`logged\n`);
  });

program
  .command("comment")
  .description("append a comment")
  .argument("<id>")
  .argument("<message>")
  .action(async (id, message) => {
    await client().post(`/api/tasks/${id}/activity`, { entry_type: "comment", body: message });
    process.stdout.write(`commented\n`);
  });

program
  .command("activity")
  .description("show task activity timeline")
  .argument("<id>")
  .option("--json")
  .action(async (id, opts) => {
    const res = await client().get<{ activity: ActivityItem[] }>(`/api/tasks/${id}/activity`);
    if (opts.json) return emit(res.activity, true);
    for (const a of res.activity) {
      process.stdout.write(`${a.created_at}  ${a.entry_type.padEnd(7)} ${a.actor}  ${a.body}\n`);
    }
  });

program
  .command("rm")
  .description("drop (soft) or hard-delete a task")
  .argument("<id>")
  .option("--hard", "permanently delete")
  .action(async (id, opts) => {
    await client().del(`/api/tasks/${id}${opts.hard ? "?hard=true" : ""}`);
    process.stdout.write(opts.hard ? "deleted\n" : "dropped\n");
  });

// ─────────────────────────────── search ───────────────────────────────
program
  .command("search")
  .description("hybrid search over tasks")
  .argument("<query>")
  .option("--status <s>")
  .option("--label <k=v>")
  .option("--json")
  .action(async (query, opts) => {
    const qs = new URLSearchParams({ q: query });
    if (opts.status) qs.set("status", opts.status);
    if (opts.label) qs.set("label", normalizeLabel(opts.label));
    const res = await client().get<SearchResp>(`/api/search?${qs}`);
    if (opts.json) return emit(res, true);
    if (!res.vector) process.stdout.write("(fts-only; vector search unavailable)\n");
    for (const h of res.hits) {
      printTask(h.task);
    }
    if (res.hits.length === 0) process.stdout.write("(no matches)\n");
  });

// ─────────────────────────────── intake ───────────────────────────────
const intake = program.command("intake").description("capture & triage inbox");

intake
  .command("add")
  .description("capture a new intake")
  .option("--text <text>", "pasted text")
  .option("--image <file>", "attach an image (repeatable)", collect, [])
  .option("--label <k=v>", "label (repeatable)", collect, [])
  .option("--verb <verb>", "action verb (repeatable)", collect, [])
  .option("--wait", "wait for triage (Phase 2)")
  .option("--json")
  .action(async (opts) => {
    const labels: Record<string, string> = {};
    for (const l of opts.label as string[]) {
      const { key, value } = parseLabelArg(l);
      labels[key] = value;
    }
    const verbs = opts.verb as string[];
    const imageFiles = opts.image as string[];

    let item: unknown;
    if (imageFiles.length > 0) {
      const form = new FormData();
      if (opts.text) form.set("text", opts.text);
      if (Object.keys(labels).length) form.set("labels", JSON.stringify(labels));
      if (verbs.length) form.set("verbs", JSON.stringify(verbs));
      for (const file of imageFiles) {
        const buf = readFileSync(file);
        const blob = new Blob([new Uint8Array(buf)], { type: mimeFromPath(file) });
        form.append("image", blob, basename(file));
      }
      item = await client().postMultipart("/api/intake", form);
    } else {
      item = await client().post("/api/intake", {
        text: opts.text,
        labels: Object.keys(labels).length ? labels : undefined,
        action_verbs: verbs.length ? verbs : undefined,
      });
    }
    opts.json ? emit(item, true) : process.stdout.write(`captured ${shortId((item as { id: string }).id)}\n`);
  });

intake
  .command("ls")
  .description("list intake")
  .option("--status <s>")
  .option("--json")
  .action(async (opts) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    const res = await client().get<{ intake: unknown[] }>(`/api/intake?${qs}`);
    opts.json ? emit(res.intake, true) : printIntakeList(res.intake as never);
  });

intake
  .command("show")
  .argument("<id>")
  .option("--json")
  .action(async (id, opts) => {
    const item = await client().get(`/api/intake/${id}`);
    emit(item, true);
    if (!opts.json) {
      const i = item as { id: string; status: string; body?: string };
      process.stdout.write(`${shortId(i.id)} [${i.status}]\n${i.body ?? ""}\n`);
    }
  });

intake
  .command("promote")
  .argument("<id>")
  .option("--title <t>")
  .option("--label <k=v>", "label (repeatable)", collect, [])
  .option("--status <s>")
  .option("--json")
  .action(async (id, opts) => {
    const labels = (opts.label as string[]).map(parseLabelArg);
    const res = await client().post(`/api/intake/${id}/promote`, {
      title: opts.title,
      status: opts.status,
      labels: labels.length ? labels : undefined,
    });
    opts.json
      ? emit(res, true)
      : process.stdout.write(`promoted → task ${shortId((res as { taskId: string }).taskId)}\n`);
  });

intake
  .command("link")
  .argument("<id>")
  .requiredOption("--task <task-id>")
  .action(async (id, opts) => {
    await client().post(`/api/intake/${id}/link`, { task_id: opts.task });
    process.stdout.write("linked\n");
  });

intake
  .command("discard")
  .argument("<id>")
  .requiredOption("--reason <reason>", "noise|duplicate|irrelevant|merged")
  .action(async (id, opts) => {
    await client().post(`/api/intake/${id}/discard`, { reason: opts.reason });
    process.stdout.write("discarded\n");
  });

intake
  .command("retriage")
  .argument("<id>")
  .action(async (id) => {
    await client().post(`/api/intake/${id}/retriage`);
    process.stdout.write("requeued\n");
  });

// ─────────────────────────────── jobs ─────────────────────────────────
const jobs = program.command("jobs").description("triage job observability");
jobs
  .option("--status <s>")
  .option("--json")
  .action(async (opts) => {
    const qs = new URLSearchParams();
    if (opts.status) qs.set("status", opts.status);
    const res = await client().get<{ counts: unknown; jobs: JobItem[] }>(`/api/triage/jobs?${qs}`);
    if (opts.json) return emit(res, true);
    process.stdout.write(`${JSON.stringify(res.counts)}\n`);
    for (const j of res.jobs) {
      process.stdout.write(`${shortId(j.id)}  ${j.status.padEnd(8)} intake=${shortId(j.intake_id)} attempts=${j.attempts}\n`);
    }
  });
jobs
  .command("requeue")
  .argument("<id>")
  .action(async (id) => {
    await client().post(`/api/triage/jobs/${id}/requeue`);
    process.stdout.write("requeued\n");
  });

// ─────────────────────────────── token ────────────────────────────────
const token = program.command("token").description("actor tokens");
token
  .command("create")
  .requiredOption("--actor <actor>")
  .action(async (opts) => {
    const res = await client().post<{ token: string }>("/api/tokens", { actor: opts.actor });
    process.stdout.write(`${res.token}\n`);
  });

// ─────────────────────────────── daemon ───────────────────────────────
const daemon = program.command("daemon").description("manage the tq daemon");
daemon.command("start").action(() => daemonStart());
daemon.command("stop").action(() => daemonStop());
daemon.command("status").action(() => daemonStatus());
daemon.command("logs").action(() => daemonLogs());

// ─────────────────────────────── helpers ──────────────────────────────
function collect(value: string, prev: string[]): string[] {
  return [...prev, value];
}
function normalizeLabel(s: string): string {
  const { key, value } = parseLabelArg(s);
  return `${key}:${value}`;
}
function mimeFromPath(path: string): string {
  const ext = extname(path).toLowerCase();
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}

interface ActivityItem {
  created_at: string;
  entry_type: string;
  actor: string;
  body: string;
}
interface JobItem {
  id: string;
  intake_id: string;
  status: string;
  attempts: number;
}
interface SearchResp {
  vector: boolean;
  hits: { task: { id: string; title: string; status: string; labels?: { key: string; value: string }[] } }[];
}

function printTaskDetail(task: unknown): void {
  const t = task as {
    id: string;
    title: string;
    status: string;
    body?: string;
    labels?: { key: string; value: string }[];
    refs?: { kind: string; url: string }[];
    activity?: ActivityItem[];
  };
  process.stdout.write(`${t.id}\n${t.title}  [${t.status}]\n`);
  if (t.labels?.length) process.stdout.write(`labels: ${t.labels.map((l) => `${l.key}:${l.value}`).join(" ")}\n`);
  if (t.refs?.length) process.stdout.write(`refs:\n${t.refs.map((r) => `  ${r.kind} ${r.url}`).join("\n")}\n`);
  if (t.body) process.stdout.write(`\n${t.body}\n`);
  if (t.activity?.length) {
    process.stdout.write(`\nactivity:\n`);
    for (const a of t.activity) process.stdout.write(`  ${a.created_at} ${a.entry_type} ${a.actor}: ${a.body}\n`);
  }
}

// ─────────────────────────────── run ──────────────────────────────────
program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(err.code);
  }
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(EXIT.generic);
});
