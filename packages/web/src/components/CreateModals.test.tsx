import { afterEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NewIntakeModal, NewTaskModal } from "../components/CreateModals";
import { db, resetDb, server } from "../test/server";
import { renderWithClient } from "../test/utils";

afterEach(resetDb);

describe("NewTaskModal", () => {
  it("creates a task with title, priority and labels", async () => {
    const user = userEvent.setup();
    let closed = false;
    server.use(
      http.post("*/api/tasks", async ({ request }) => {
        db.calls.push({ method: "POST", url: "/tasks", body: await request.json() });
        return HttpResponse.json({ id: "t-new" }, { status: 201 });
      }),
    );
    renderWithClient(<NewTaskModal onClose={() => (closed = true)} />);

    await user.type(screen.getByTestId("task-title"), "Write the docs");
    await user.type(screen.getByPlaceholderText("project:tq"), "project:tq");
    await user.click(screen.getByTestId("task-submit"));

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/tasks");
      expect(call).toBeTruthy();
      const body = call!.body as { title: string; labels: { key: string; value: string }[] };
      expect(body.title).toBe("Write the docs");
      expect(body.labels).toEqual([{ key: "project", value: "tq" }]);
    });
    await waitFor(() => expect(closed).toBe(true));
  });

  it("keeps submit disabled until a title is entered", async () => {
    renderWithClient(<NewTaskModal onClose={() => {}} />);
    expect(screen.getByTestId("task-submit")).toBeDisabled();
  });
});

describe("NewIntakeModal", () => {
  it("captures text intake as multipart", async () => {
    const user = userEvent.setup();
    let contentType = "";
    server.use(
      http.post("*/api/intake", async ({ request }) => {
        contentType = request.headers.get("content-type") ?? "";
        const fd = await request.formData();
        db.calls.push({
          method: "POST",
          url: "/intake",
          body: { text: fd.get("text"), labels: fd.get("labels") },
        });
        return HttpResponse.json({ id: "i-new", status: "new" }, { status: 202 });
      }),
    );
    renderWithClient(<NewIntakeModal onClose={() => {}} />);

    await user.type(screen.getByTestId("intake-text"), "a captured thought");
    await user.click(screen.getByTestId("intake-submit"));

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/intake");
      expect(call).toBeTruthy();
      expect((call!.body as { text: string }).text).toBe("a captured thought");
    });
    expect(contentType).toContain("multipart/form-data");
  });

  it("disables capture when empty", () => {
    renderWithClient(<NewIntakeModal onClose={() => {}} />);
    expect(screen.getByTestId("intake-submit")).toBeDisabled();
  });

  it("attaches images via the file picker and submits them", async () => {
    const user = userEvent.setup();
    let hit = false;
    let contentType = "";
    server.use(
      http.post("*/api/intake", ({ request }) => {
        hit = true;
        contentType = request.headers.get("content-type") ?? "";
        return HttpResponse.json({ id: "i-img", status: "new" }, { status: 202 });
      }),
    );
    renderWithClient(<NewIntakeModal onClose={() => {}} />);

    // Empty state shows the attach button; submit is disabled with no text/images.
    expect(screen.getByTestId("intake-submit")).toBeDisabled();

    const file = new File(["fake-png-bytes"], "shot.png", { type: "image/png" });
    await user.upload(screen.getByTestId("attach-input"), file);

    // A thumbnail renders and capture becomes enabled even without any text.
    expect(await screen.findByAltText("shot.png")).toBeInTheDocument();
    expect(screen.getByTestId("intake-submit")).toBeEnabled();

    await user.click(screen.getByTestId("intake-submit"));
    await waitFor(() => expect(hit).toBe(true));
    expect(contentType).toContain("multipart/form-data");
  });

  it("ignores non-image files from the picker", async () => {
    const user = userEvent.setup();
    renderWithClient(<NewIntakeModal onClose={() => {}} />);
    const txt = new File(["hello"], "notes.txt", { type: "text/plain" });
    await user.upload(screen.getByTestId("attach-input"), txt);
    // Still empty: no thumbnail, submit stays disabled, attach button visible.
    expect(screen.getByTestId("attach-images")).toBeInTheDocument();
    expect(screen.getByTestId("intake-submit")).toBeDisabled();
  });
});
