import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { taskApi } from "../api/client";
import { qk } from "../api/events";
import { rankBetween } from "../lib/rank";
import { TASK_STATUSES, type Task, type TaskStatus } from "../api/types";
import { BoardColumn } from "../components/BoardColumn";
import { BoardCard } from "../components/BoardCard";

type BoardState = Record<TaskStatus, Task[]>;

const COLUMN_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  next: "Next",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

export function Board() {
  const qc = useQueryClient();
  const [columns, setColumns] = useState<BoardState | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const board = useQuery({
    queryKey: qk.board(),
    queryFn: taskApi.board,
  });

  // Sync local DnD state from the server whenever we're not mid-drag.
  useEffect(() => {
    if (board.data && !activeId) setColumns(normalize(board.data));
  }, [board.data, activeId]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const view = columns ?? (board.data ? normalize(board.data) : null);
  const activeTask = view ? findTask(view, activeId) : null;

  function onDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
  }

  function onDragOver(e: DragOverEvent) {
    if (!view) return;
    const activeCol = findColumn(view, String(e.active.id));
    const overId = e.over ? String(e.over.id) : null;
    if (!overId || !activeCol) return;
    const overCol = isStatus(overId)
      ? overId
      : findColumn(view, overId);
    if (!overCol || overCol === activeCol) return;

    // Move the dragged card into the column it's hovering over.
    setColumns((prev) => {
      const base = prev ?? view!;
      const card = base[activeCol].find((t) => t.id === String(e.active.id));
      if (!card) return base;
      const next: BoardState = { ...base };
      next[activeCol] = base[activeCol].filter((t) => t.id !== card.id);
      const overItems = base[overCol];
      const overIdx = isStatus(overId)
        ? overItems.length
        : overItems.findIndex((t) => t.id === overId);
      next[overCol] = [...overItems];
      next[overCol].splice(overIdx < 0 ? overItems.length : overIdx, 0, {
        ...card,
        status: overCol,
      });
      return next;
    });
  }

  function onDragEnd(e: DragEndEvent) {
    const id = String(e.active.id);
    setActiveId(null);
    if (!view) return;
    const col = findColumn(view, id);
    const overId = e.over ? String(e.over.id) : null;
    if (!col) return;

    // Reorder within the final column.
    let finalCols = columns ?? view;
    if (overId && !isStatus(overId) && overId !== id) {
      const items = finalCols[col];
      const from = items.findIndex((t) => t.id === id);
      const to = items.findIndex((t) => t.id === overId);
      if (from !== -1 && to !== -1 && from !== to) {
        finalCols = { ...finalCols, [col]: arrayMove(items, from, to) };
        setColumns(finalCols);
      }
    }

    persistMove(id, col, finalCols);
  }

  async function persistMove(id: string, status: TaskStatus, cols: BoardState) {
    const items = cols[status];
    const idx = items.findIndex((t) => t.id === id);
    const prev = items[idx - 1]?.board_rank ?? null;
    const next = items[idx + 1]?.board_rank ?? null;
    let rank: string | undefined;
    try {
      rank = rankBetween(prev, next);
    } catch {
      rank = undefined; // neighbours out of order mid-flight; let server keep rank
    }
    try {
      await taskApi.move(id, status, rank);
    } finally {
      void qc.invalidateQueries({ queryKey: qk.board() });
    }
  }

  // Deterministic, accessible move path (also used by tests / cmux).
  async function moveViaSelect(id: string, status: TaskStatus) {
    const cols = view!;
    const target = cols[status];
    const lastRank = target[target.length - 1]?.board_rank ?? null;
    let rank: string | undefined;
    try {
      rank = rankBetween(lastRank, null);
    } catch {
      rank = undefined;
    }
    await taskApi.move(id, status, rank);
    void qc.invalidateQueries({ queryKey: qk.board() });
  }

  if (board.error) {
    return (
      <div className="error-banner">
        Failed to load board: {(board.error as Error).message}
      </div>
    );
  }
  if (!view) return <div className="empty">Loading…</div>;

  const total = TASK_STATUSES.reduce((n, s) => n + view[s].length, 0);

  return (
    <section className="board-wrap">
      <div className="inbox-head">
        <h1>Board</h1>
        <span className="inbox-counts" data-testid="board-counts">
          {total} tasks
        </span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
      >
        <div className="board" data-testid="board">
          {TASK_STATUSES.map((status) => (
            <BoardColumn
              key={status}
              status={status}
              label={COLUMN_LABELS[status]}
              tasks={view[status]}
              onSelectMove={moveViaSelect}
            />
          ))}
        </div>
        <DragOverlay>
          {activeTask ? <BoardCard task={activeTask} overlay /> : null}
        </DragOverlay>
      </DndContext>
    </section>
  );
}

// ─────────────────────────────── helpers ──────────────────────────────
function normalize(board: Record<string, Task[]>): BoardState {
  const out = {} as BoardState;
  for (const s of TASK_STATUSES) out[s] = board[s] ?? [];
  return out;
}
function isStatus(id: string): id is TaskStatus {
  return (TASK_STATUSES as string[]).includes(id);
}
function findColumn(cols: BoardState, cardId: string): TaskStatus | null {
  for (const s of TASK_STATUSES) {
    if (cols[s].some((t) => t.id === cardId)) return s;
  }
  return null;
}
function findTask(cols: BoardState, id: string | null): Task | null {
  if (!id) return null;
  for (const s of TASK_STATUSES) {
    const t = cols[s].find((x) => x.id === id);
    if (t) return t;
  }
  return null;
}
