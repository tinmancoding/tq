import { useQueries } from "@tanstack/react-query";
import { intakeApi } from "../api/client";
import { qk } from "../api/events";
import type { Intake } from "../api/types";
import { IntakeCard } from "../components/IntakeCard";

/**
 * Triage inbox — the visual verify-gate (design §10). Shows `new` (awaiting
 * triage) and `triaged` (awaiting human decision) intakes. Promoted/discarded
 * fall out of the inbox.
 */
export function TriageInbox() {
  const results = useQueries({
    queries: [
      {
        queryKey: qk.intakeList("new"),
        queryFn: () => intakeApi.list({ status: "new" }),
      },
      {
        queryKey: qk.intakeList("triaged"),
        queryFn: () => intakeApi.list({ status: "triaged" }),
      },
    ],
  });

  const isLoading = results.some((r) => r.isLoading);
  const error = results.find((r) => r.error)?.error;

  const intakes: Intake[] = [
    ...(results[0].data ?? []),
    ...(results[1].data ?? []),
  ].sort((a, b) => b.created_at.localeCompare(a.created_at));

  const newCount = results[0].data?.length ?? 0;
  const triagedCount = results[1].data?.length ?? 0;

  return (
    <section className="inbox">
      <div className="inbox-head">
        <h1>Triage inbox</h1>
        <span className="inbox-counts" data-testid="inbox-counts">
          {triagedCount} to review · {newCount} triaging
        </span>
      </div>

      {error && (
        <div className="error-banner">
          Failed to load intake: {(error as Error).message}
        </div>
      )}

      {isLoading && intakes.length === 0 && (
        <div className="empty">Loading…</div>
      )}

      {!isLoading && intakes.length === 0 && (
        <div className="empty" data-testid="inbox-empty">
          Inbox zero. Nothing to triage. 🎉
        </div>
      )}

      <div className="inbox-list" data-testid="inbox-list">
        {intakes.map((intake) => (
          <IntakeCard key={intake.id} intake={intake} />
        ))}
      </div>
    </section>
  );
}
