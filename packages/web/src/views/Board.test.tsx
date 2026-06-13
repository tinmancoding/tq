import { afterEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Board } from "../views/Board";
import { db, resetDb } from "../test/server";
import { makeTask, renderWithClient } from "../test/utils";

afterEach(resetDb);

describe("Board", () => {
  it("renders columns with tasks grouped by status", async () => {
    db.board = {
      backlog: [makeTask({ id: "t1", title: "Backlog task" })],
      doing: [makeTask({ id: "t2", title: "Doing task", status: "doing" })],
    };
    renderWithClient(<Board />);

    expect(await screen.findByText("Backlog task")).toBeInTheDocument();
    const doingCol = screen.getByTestId("col-doing");
    expect(within(doingCol).getByText("Doing task")).toBeInTheDocument();
    expect(screen.getByTestId("board-counts")).toHaveTextContent("2 tasks");
  });

  it("moves a task to another status via the select affordance with a rank", async () => {
    const user = userEvent.setup();
    db.board = {
      backlog: [makeTask({ id: "t1", title: "Movable", board_rank: "V" })],
      next: [],
    };
    renderWithClient(<Board />);

    await screen.findByText("Movable");
    const card = screen.getByTestId("board-card");
    await user.selectOptions(within(card).getByTestId("move-select"), "doing");

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/tasks/t1/move");
      expect(call).toBeTruthy();
      const body = call!.body as { status: string; board_rank?: string };
      expect(body.status).toBe("doing");
      expect(typeof body.board_rank).toBe("string");
    });
  });

  it("appends with an increasing rank when the target column already has ranked cards", async () => {
    const user = userEvent.setup();
    db.board = {
      backlog: [makeTask({ id: "t1", title: "Mover" })],
      done: [makeTask({ id: "t9", title: "Existing", status: "done", board_rank: "V" })],
    };
    renderWithClient(<Board />);

    await screen.findByText("Mover");
    const movers = screen.getAllByTestId("board-card");
    const moverCard = movers.find((c) => within(c).queryByText("Mover"))!;
    await user.selectOptions(within(moverCard).getByTestId("move-select"), "done");

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/tasks/t1/move");
      const body = call!.body as { board_rank?: string };
      // appended after existing rank "V"
      expect(body.board_rank! > "V").toBe(true);
    });
  });
});
