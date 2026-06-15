import type {
  Activity,
  CreateTaskInput,
  HealthSnapshot,
  Intake,
  IntakeDetail,
  Label,
  MoveTaskInput,
  PromoteIntakeInput,
  SetContextResult,
  Task,
  TaskDetail,
  TaskRef,
  TaskStatus,
  TriageTraceStep,
  UpdateTaskInput,
} from "./schemas.js";

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

export interface CoreClientOptions {
  /** Daemon base URL, e.g. http://127.0.0.1:7788. Use "" for same-origin (web). */
  baseUrl?: string;
  /** Injectable fetch (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Actor attribution; sent as X-TQ-Actor unless a token is provided. */
  actor?: string;
  /** Token attribution; sent as X-TQ-Token (wins over actor). */
  token?: string;
}

export interface EventStreamQuery {
  since?: number;
  types?: string[];
  scopeType?: "task" | "intake" | "global";
}

/**
 * The typed TQ client. This is the object the extension SDK injects as the
 * CoreClient, and what the web + CLI build on. Every method maps 1:1 to a
 * public REST endpoint; types come from the shared contract schemas.
 */
export function createCoreClient(opts: CoreClientOptions = {}) {
  const base = opts.baseUrl ?? "";
  const doFetch = opts.fetch ?? globalThis.fetch;

  const headers = (hasBody: boolean): Record<string, string> => {
    const h: Record<string, string> = {};
    if (hasBody) h["Content-Type"] = "application/json";
    if (opts.token) h["X-TQ-Token"] = opts.token;
    else if (opts.actor) h["X-TQ-Actor"] = opts.actor;
    return h;
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}/api${path}`, {
      method,
      headers: headers(body !== undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const detail =
        json && typeof json === "object" ? (json.detail ?? json.error) : undefined;
      throw new ApiError(res.status, detail ?? `HTTP ${res.status}`, detail);
    }
    return json as T;
  }

  const qs = (params: Record<string, string | undefined>): string => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, v);
    const s = q.toString();
    return s ? `?${s}` : "";
  };

  return {
    request,

    tasks: {
      create: (input: CreateTaskInput) => request<Task>("POST", "/tasks", input),
      list: (params: { status?: string; label?: string } = {}) =>
        request<{ tasks: Task[] }>("GET", `/tasks${qs(params)}`).then((r) => r.tasks),
      board: () =>
        request<{ group: "status"; board: Record<TaskStatus, Task[]> }>(
          "GET",
          "/tasks?group=status",
        ).then((r) => r.board),
      get: (id: string) => request<TaskDetail>("GET", `/tasks/${id}`),
      update: (id: string, patch: UpdateTaskInput) => request<Task>("PATCH", `/tasks/${id}`, patch),
      move: (id: string, input: MoveTaskInput) => request<Task>("POST", `/tasks/${id}/move`, input),
      remove: (id: string, hard = false) =>
        request<void>("DELETE", `/tasks/${id}${hard ? "?hard=true" : ""}`),
      addLabel: (id: string, label: Label) => request<Task>("POST", `/tasks/${id}/labels`, label),
      removeLabel: (id: string, label: Label) =>
        request<Task>(
          "DELETE",
          `/tasks/${id}/labels/${encodeURIComponent(label.key)}/${encodeURIComponent(label.value)}`,
        ),
      addRef: (id: string, ref: { kind: string; url: string; external_id?: string; title?: string }) =>
        request<TaskRef>("POST", `/tasks/${id}/refs`, ref),
      addActivity: (id: string, entry: { entry_type: "worklog" | "comment"; body: string }) =>
        request<Activity>("POST", `/tasks/${id}/activity`, entry),
      listActivity: (id: string) =>
        request<{ activity: Activity[] }>("GET", `/tasks/${id}/activity`).then((r) => r.activity),
    },

    intake: {
      list: (params: { status?: string; source?: string } = {}) =>
        request<{ intake: Intake[] }>("GET", `/intake${qs(params)}`).then((r) => r.intake),
      get: (id: string) => request<IntakeDetail>("GET", `/intake/${id}`),
      create: (input: { text?: string; labels?: Record<string, string> }) =>
        request<Intake>("POST", "/intake", input),
      promote: (id: string, payload: PromoteIntakeInput) =>
        request<{ intake: Intake; taskId: string }>("POST", `/intake/${id}/promote`, payload),
      link: (id: string, taskId: string, relation = "linked") =>
        request<unknown>("POST", `/intake/${id}/link`, { task_id: taskId, relation }),
      discard: (id: string, reason: string) =>
        request<unknown>("POST", `/intake/${id}/discard`, { reason }),
      retriage: (id: string) => request<unknown>("POST", `/intake/${id}/retriage`),
      trace: (id: string) =>
        request<{ trace: TriageTraceStep[] }>("GET", `/intake/${id}/trace`),
    },

    context: {
      set: (scope: "tasks" | "intake", id: string, namespace: string, value: unknown) =>
        request<SetContextResult>("PUT", `/${scope}/${id}/context/${namespace}`, value),
    },

    system: {
      health: () => request<HealthSnapshot>("GET", "/health"),
    },

    events: {
      /** Absolute URL for an EventSource against the durable stream. */
      url: (q: EventStreamQuery = {}): string => {
        const params: Record<string, string | undefined> = {
          since: q.since !== undefined ? String(q.since) : undefined,
          types: q.types?.length ? q.types.join(",") : undefined,
          scope_type: q.scopeType,
        };
        return `${base}/api/events${qs(params)}`;
      },
    },
  };
}

export type CoreClient = ReturnType<typeof createCoreClient>;
