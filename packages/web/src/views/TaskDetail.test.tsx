import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TaskDetail } from "../views/TaskDetail";
import { db, resetDb, server } from "../test/server";
import { makeTask, renderWithClient } from "../test/utils";
import type { TaskDetail as TaskDetailT } from "../api/types";

afterEach(resetDb);

function mountDetail(detail: TaskDetailT) {
  server.use(
    http.get("*/api/tasks/:id", () => HttpResponse.json(detail)),
    http.patch("*/api/tasks/:id", async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>;
      db.calls.push({ method: "PATCH", url: `/tasks/${params.id}`, body });
      return HttpResponse.json({ ...detail, ...body });
    }),
    http.post("*/api/tasks/:id/activity", async ({ request, params }) => {
      db.calls.push({ method: "POST", url: `/tasks/${params.id}/activity`, body: await request.json() });
      return HttpResponse.json({ id: "a1" }, { status: 201 });
    }),
  );
  renderWithClient(<TaskDetail id={detail.id} />);
}

describe("TaskDetail", () => {
  it("renders title, status, labels, linked intakes and activity", async () => {
    mountDetail({
      ...makeTask({ id: "t1", title: "Detailed task", status: "doing" }),
      activity: [
        {
          id: "a0",
          task_id: "t1",
          entry_type: "system",
          actor: "agent:triage",
          body: "promoted from intake abc",
          meta: null,
          created_at: new Date().toISOString(),
        },
      ],
      linked_intakes: [{ id: "intake-9", relation: "source", summary: "the source intake" }],
    });

    expect(await screen.findByTestId("detail-title")).toHaveTextContent("Detailed task");
    expect(screen.getByTestId("detail-status")).toHaveValue("doing");
    expect(screen.getByText("the source intake")).toBeInTheDocument();
    expect(screen.getByText("promoted from intake abc")).toBeInTheDocument();
  });

  it("edits the title via the inline editor", async () => {
    const user = userEvent.setup();
    mountDetail({ ...makeTask({ id: "t1", title: "Old" }), activity: [], linked_intakes: [] });

    await user.click(await screen.findByTestId("detail-title"));
    const input = screen.getByTestId("detail-title-input");
    await user.clear(input);
    await user.type(input, "New title{Enter}");

    await waitFor(() => {
      const call = db.calls.find((c) => c.method === "PATCH");
      expect((call!.body as { title: string }).title).toBe("New title");
    });
  });

  it("adds a worklog entry", async () => {
    const user = userEvent.setup();
    mountDetail({ ...makeTask({ id: "t1" }), activity: [], linked_intakes: [] });

    await user.type(await screen.findByTestId("activity-input"), "pushed a fix");
    await user.click(screen.getByTestId("activity-submit"));

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/tasks/t1/activity");
      expect((call!.body as { body: string }).body).toBe("pushed a fix");
    });
  });
});
