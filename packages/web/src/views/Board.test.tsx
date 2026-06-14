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

  it("moves a task to another status via the card menu with a rank", async () => {
    const user = userEvent.setup();
    db.board = {
      backlog: [makeTask({ id: "t1", title: "Movable", board_rank: "V" })],
      next: [],
    };
    renderWithClient(<Board />);

    await screen.findByText("Movable");
    const card = screen.getByTestId("board-card");
    await user.click(within(card).getByTestId("card-menu"));
    await user.click(screen.getByTestId("menu-move"));
    await user.click(screen.getByTestId("move-to-doing"));

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/tasks/t1/move");
      expect(call).toBeTruthy();
      const body = call!.body as { status: string; board_rank?: string };
      expect(body.status).toBe("doing");
      expect(typeof body.board_rank).toBe("string");
    });
  });

  it("offers View details and hides the current status from Move to", async () => {
    const user = userEvent.setup();
    db.board = { backlog: [makeTask({ id: "t1", title: "Menu task" })] };
    renderWithClient(<Board />);

    await screen.findByText("Menu task");
    const card = screen.getByTestId("board-card");
    await user.click(within(card).getByTestId("card-menu"));
    expect(screen.getByTestId("menu-view-details")).toBeInTheDocument();
    await user.click(screen.getByTestId("menu-move"));
    // current column (backlog) is excluded from the move targets
    expect(screen.queryByTestId("move-to-backlog")).not.toBeInTheDocument();
    expect(screen.getByTestId("move-to-done")).toBeInTheDocument();
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
    await user.click(within(moverCard).getByTestId("card-menu"));
    await user.click(screen.getByTestId("menu-move"));
    await user.click(screen.getByTestId("move-to-done"));

    await waitFor(() => {
      const call = db.calls.find((c) => c.url === "/tasks/t1/move");
      const body = call!.body as { board_rank?: string };
      // appended after existing rank "V"
      expect(body.board_rank! > "V").toBe(true);
    });
  });
});
