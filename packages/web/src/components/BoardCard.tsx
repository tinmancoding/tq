import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { TASK_STATUSES, type Task, type TaskStatus } from "../api/types";

export function BoardCard({
  task,
  overlay,
  onSelectMove,
}: {
  task: Task;
  overlay?: boolean;
  onSelectMove?: (id: string, status: TaskStatus) => void;
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
      <div className="bcard-grip" {...attributes} {...listeners}>
        <div className="bcard-title">{task.title}</div>
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

      {onSelectMove && !overlay && (
        <div className="bcard-foot">
          <span className="bcard-id">{task.id.slice(0, 8)}</span>
          <select
            className="move-select"
            data-testid="move-select"
            value={task.status}
            onChange={(e) => onSelectMove(task.id, e.target.value as TaskStatus)}
            onClick={(e) => e.stopPropagation()}
          >
            {TASK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
      )}
    </article>
  );
}
