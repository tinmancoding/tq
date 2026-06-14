import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { navigate } from "../api/router";
import { TASK_STATUSES, type Task, type TaskStatus } from "../api/types";

const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  next: "Next",
  doing: "Doing",
  blocked: "Blocked",
  done: "Done",
  dropped: "Dropped",
};

export function BoardCard({
  task,
  overlay,
  onMove,
}: {
  task: Task;
  overlay?: boolean;
  onMove?: (id: string, status: TaskStatus) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <article
      ref={overlay ? undefined : setNodeRef}
      style={overlay ? undefined : style}
      className={`bcard${overlay ? " bcard-overlay" : ""}`}
      data-testid="board-card"
      data-task={task.id}
    >
      {/* Action menu lives outside the drag handle so it never starts a drag. */}
      {!overlay && onMove && <CardMenu task={task} onMove={onMove} />}

      <div className="bcard-grip" {...(overlay ? {} : attributes)} {...(overlay ? {} : listeners)}>
        <div
          className="bcard-title"
          onClick={() => !overlay && navigate(`/task/${task.id}`)}
        >
          {task.title}
        </div>
        {task.priority && (
          <span className={`prio prio-${task.priority}`}>{task.priority}</span>
        )}
      </div>

      {(task.labels.length > 0 || task.refs.length > 0) && (
        <div className="bcard-meta">
          {task.labels.map((l, i) => (
            <span key={i} className="chip chip-sm">
              <span className="chip-k">{l.key}</span>
              <span className="chip-v">{l.value}</span>
            </span>
          ))}
          {task.refs.map((r) => (
            <a
              key={r.id}
              className="ref-chip"
              href={r.url}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              {r.kind}
              {r.external_id ? ` #${r.external_id}` : ""}
            </a>
          ))}
        </div>
      )}

      {/* Foot renders in both real + overlay cards so the dragged card is complete. */}
      <div className="bcard-foot">
        <span className="bcard-id" title={task.id}>
          {task.id.slice(0, 8)}
        </span>
        <span className={`status-dot status-${task.status}`}>{STATUS_LABELS[task.status]}</span>
      </div>
    </article>
  );
}

// ───────────────────────────── card action menu ────────────────────────
function CardMenu({
  task,
  onMove,
}: {
  task: Task;
  onMove: (id: string, status: TaskStatus) => void;
}) {
  const [open, setOpen] = useState(false);
  const [moveMode, setMoveMode] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape / scroll / resize while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || popRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setMoveMode(false);
  }

  function toggle() {
    if (open) return close();
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setMoveMode(false);
    setOpen(true);
  }

  return (
    <div className="bcard-menu-wrap">
      <button
        ref={btnRef}
        type="button"
        className="bcard-menu-btn"
        data-testid="card-menu"
        aria-label="Card actions"
        aria-haspopup="menu"
        aria-expanded={open}
        // Stop pointer events from reaching the sortable so it never drags.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          toggle();
        }}
      >
        ⋯
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popRef}
            className="card-popover"
            role="menu"
            style={{ position: "fixed", top: pos.top, right: pos.right }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {!moveMode ? (
              <>
                <button
                  type="button"
                  className="popover-item"
                  role="menuitem"
                  data-testid="menu-view-details"
                  onClick={(e) => {
                    e.stopPropagation();
                    close();
                    navigate(`/task/${task.id}`);
                  }}
                >
                  View details…
                </button>
                <button
                  type="button"
                  className="popover-item"
                  role="menuitem"
                  data-testid="menu-move"
                  onClick={(e) => {
                    e.stopPropagation();
                    setMoveMode(true);
                  }}
                >
                  Move to…
                </button>
              </>
            ) : (
              <>
                <div className="popover-head">Move to…</div>
                {TASK_STATUSES.filter((s) => s !== task.status).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="popover-item"
                    role="menuitem"
                    data-testid={`move-to-${s}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      close();
                      onMove(task.id, s);
                    }}
                  >
                    {STATUS_LABELS[s]}
                  </button>
                ))}
              </>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
