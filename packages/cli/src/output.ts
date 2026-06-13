/** Output helpers: --json passthrough or compact human formatting. */

export function emit(data: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
  }
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

interface TaskLike {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  labels?: { key: string; value: string }[];
}

export function printTask(t: TaskLike): void {
  const labels = (t.labels ?? []).map((l) => `${l.key}:${l.value}`).join(" ");
  const pri = t.priority ? ` [${t.priority}]` : "";
  process.stdout.write(`${shortId(t.id)}  ${t.status.padEnd(8)}${pri}  ${t.title}${labels ? `  (${labels})` : ""}\n`);
}

export function printTaskList(tasks: TaskLike[]): void {
  if (tasks.length === 0) {
    process.stdout.write("(no tasks)\n");
    return;
  }
  for (const t of tasks) printTask(t);
}

interface IntakeLike {
  id: string;
  status: string;
  source: string;
  body?: string | null;
}

export function printIntakeList(items: IntakeLike[]): void {
  if (items.length === 0) {
    process.stdout.write("(no intake)\n");
    return;
  }
  for (const i of items) {
    const preview = (i.body ?? "").split("\n")[0]?.slice(0, 60) ?? "";
    process.stdout.write(`${shortId(i.id)}  ${i.status.padEnd(9)} ${i.source.padEnd(8)}  ${preview}\n`);
  }
}

/** Parse a "key=value" or "key:value" label argument. */
export function parseLabelArg(s: string): { key: string; value: string } {
  const m = s.match(/^([^=:]+)[=:](.+)$/);
  if (!m) throw new Error(`invalid label "${s}" (expected key=value)`);
  return { key: m[1]!.trim(), value: m[2]!.trim() };
}
