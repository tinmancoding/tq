import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IntakeDetail, Task } from "../api/types";

export function renderWithClient(ui: ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  );
}

export function makeTriagedIntake(over: Partial<IntakeDetail> = {}): IntakeDetail {
  return {
    id: "intake-1",
    status: "triaged",
    source: "manual",
    source_ref: null,
    event_sig: null,
    body: "raw captured text",
    action_verbs: null,
    discard_reason: null,
    triage_error: null,
    labels: null,
    watchlist_id: null,
    created_at: new Date().toISOString(),
    triaged_at: new Date().toISOString(),
    linked_task_ids: [],
    attachments: [],
    triage: {
      summary: "A clear actionable summary",
      category: "chore",
      suggested_title: "Suggested task title",
      suggested_body: "enriched body",
      suggested_labels: [{ key: "project", value: "tq" }],
      suggested_action_verbs: ["fix"],
      refs: [],
      duplicate: { decision: "none" },
      actionable_confidence: 0.62,
      task_count_suggestion: 1,
    },
    ...over,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "A task",
    body: null,
    status: "backlog",
    priority: null,
    due_at: null,
    snooze_until: null,
    board_rank: null,
    created_by: "human:laci",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    done_at: null,
    status_changed_at: new Date().toISOString(),
    labels: [],
    refs: [],
    ...over,
  };
}
