import type {
  HealthSnapshot,
  Intake,
  IntakeDetail,
  Label,
  Priority,
  Task,
  TaskRef,
  TaskStatus,
  TriageTraceStep,
} from "./types";

// Same-origin in dev (Vite proxies /api → daemon) and in prod (daemon serves
// the built app at /). Actor is client-supplied per design §15.
const ACTOR = "human:laci";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      "X-TQ-Actor": ACTOR,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  if (!res.ok) {
    const detail =
      json && typeof json === "object"
        ? (json.detail ?? json.error)
        : undefined;
    throw new ApiError(res.status, detail ?? `HTTP ${res.status}`, detail);
  }
  return json as T;
}

// ─────────────────────────────── Intake ───────────────────────────────
export const intakeApi = {
  list: (params: { status?: string; source?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.source) q.set("source", params.source);
    const qs = q.toString();
    return request<{ intake: Intake[] }>(
      "GET",
      `/intake${qs ? `?${qs}` : ""}`,
    ).then((r) => r.intake);
  },

  get: (id: string) => request<IntakeDetail>("GET", `/intake/${id}`),

  create: (input: { text?: string; labels?: Record<string, string> }) =>
    request<Intake>("POST", "/intake", input),

  createMultipart: (input: {
    text?: string;
    labels?: Record<string, string>;
    verbs?: string[];
    images?: File[];
  }) => {
    const fd = new FormData();
    if (input.text) fd.set("text", input.text);
    if (input.labels) fd.set("labels", JSON.stringify(input.labels));
    if (input.verbs) fd.set("verbs", JSON.stringify(input.verbs));
    for (const img of input.images ?? []) fd.append("image", img, img.name);
    return fetch("/api/intake", {
      method: "POST",
      headers: { "X-TQ-Actor": ACTOR },
      body: fd,
    }).then(async (res) => {
      if (!res.ok) throw new ApiError(res.status, `HTTP ${res.status}`);
      return (await res.json()) as Intake;
    });
  },

  promote: (
    id: string,
    payload: {
      title?: string;
      body?: string | null;
      status?: TaskStatus;
      labels?: Label[];
    },
  ) => request<{ intake: Intake; taskId: string }>(
    "POST",
    `/intake/${id}/promote`,
    payload,
  ),

  link: (id: string, taskId: string, relation = "linked") =>
    request<unknown>("POST", `/intake/${id}/link`, {
      task_id: taskId,
      relation,
    }),

  discard: (id: string, reason: string) =>
    request<unknown>("POST", `/intake/${id}/discard`, { reason }),

  retriage: (id: string) =>
    request<unknown>("POST", `/intake/${id}/retriage`),

  trace: (id: string) =>
    request<{ trace: TriageTraceStep[] }>("GET", `/intake/${id}/trace`),
};

// ─────────────────────────────── Tasks ────────────────────────────────
export const taskApi = {
  create: (input: {
    title: string;
    body?: string;
    priority?: Priority;
    labels?: Label[];
  }) => request<Task>("POST", "/tasks", input),

  list: (params: { status?: string; label?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set("status", params.status);
    if (params.label) q.set("label", params.label);
    const qs = q.toString();
    return request<{ tasks: Task[] }>(
      "GET",
      `/tasks${qs ? `?${qs}` : ""}`,
    ).then((r) => r.tasks);
  },

  board: () =>
    request<{ group: "status"; board: Record<TaskStatus, Task[]> }>(
      "GET",
      "/tasks?group=status",
    ).then((r) => r.board),

  get: (id: string) =>
    request<import("./types").TaskDetail>("GET", `/tasks/${id}`),

  update: (
    id: string,
    patch: {
      title?: string;
      body?: string | null;
      priority?: Priority | null;
      due_at?: string | null;
      snooze_until?: string | null;
    },
  ) => request<Task>("PATCH", `/tasks/${id}`, patch),

  addLabel: (id: string, label: Label) =>
    request<Task>("POST", `/tasks/${id}/labels`, label),

  removeLabel: (id: string, label: Label) =>
    request<Task>(
      "DELETE",
      `/tasks/${id}/labels/${encodeURIComponent(label.key)}/${encodeURIComponent(label.value)}`,
    ),

  addRef: (
    id: string,
    ref: { kind: string; url: string; external_id?: string; title?: string },
  ) => request<TaskRef>("POST", `/tasks/${id}/refs`, ref),

  addActivity: (
    id: string,
    entry: { entry_type: "worklog" | "comment"; body: string },
  ) => request<import("./types").Activity>("POST", `/tasks/${id}/activity`, entry),

  move: (id: string, status: TaskStatus, board_rank?: string) =>
    request<Task>("POST", `/tasks/${id}/move`, { status, board_rank }),
};

// ─────────────────────────────── System ───────────────────────────────
export const systemApi = {
  health: () => request<HealthSnapshot>("GET", "/health"),
};

export const attachmentUrl = (sha256: string) => `/api/attachments/${sha256}`;
