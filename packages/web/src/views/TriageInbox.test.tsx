import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TriageInbox } from "../views/TriageInbox";
import { db, resetDb } from "../test/server";
import { makeTriagedIntake, renderWithClient } from "../test/utils";

afterEach(resetDb);

describe("TriageInbox", () => {
  it("renders a triaged intake with summary, confidence, labels and verbs", async () => {
    db.triaged = [makeTriagedIntake()];
    renderWithClient(<TriageInbox />);

    expect(
      await screen.findByText("A clear actionable summary"),
    ).toBeInTheDocument();
    expect(screen.getByText("62%")).toBeInTheDocument();
    expect(screen.getByText("project")).toBeInTheDocument();
    expect(screen.getByText("fix")).toBeInTheDocument();
  });

  it("shows inbox-zero when there is nothing to triage", async () => {
    renderWithClient(<TriageInbox />);
    expect(await screen.findByTestId("inbox-empty")).toBeInTheDocument();
  });

  it("promotes an intake with the edited title", async () => {
    const user = userEvent.setup();
    db.triaged = [makeTriagedIntake()];
    renderWithClient(<TriageInbox />);

    const card = await screen.findByTestId("intake-card");
    await user.click(within(card).getByTestId("action-promote"));

    const titleInput = await screen.findByTestId("promote-title");
    expect(titleInput).toHaveValue("Suggested task title");
    await user.clear(titleInput);
    await user.type(titleInput, "Edited title");
    await user.click(screen.getByTestId("promote-submit"));

    await waitFor(() => {
      const call = db.calls.find((c) => c.url.endsWith("/promote"));
      expect(call).toBeTruthy();
      expect((call!.body as { title: string }).title).toBe("Edited title");
    });
  });

  it("surfaces a strong duplicate candidate", async () => {
    db.triaged = [
      makeTriagedIntake({
        triage: {
          ...makeTriagedIntake().triage!,
          duplicate: { decision: "strong", task_id: "task-dup-123", reason: "same PR" },
        },
      }),
    ];
    renderWithClient(<TriageInbox />);
    const dup = await screen.findByTestId("dup-candidate");
    expect(within(dup).getByText(/Strong duplicate/)).toBeInTheDocument();
  });
});
