import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task, TaskStatus } from "../api/types";
import { BoardCard } from "./BoardCard";

export function BoardColumn({
  status,
  label,
  tasks,
  onMove,
}: {
  status: TaskStatus;
  label: string;
  tasks: Task[];
  onMove: (id: string, status: TaskStatus) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      className={`col${isOver ? " col-over" : ""}`}
      data-testid={`col-${status}`}
    >
      <div className="col-head">
        <span className="col-title">{label}</span>
        <span className="col-count">{tasks.length}</span>
      </div>
      <div className="col-body" ref={setNodeRef}>
        <SortableContext
          items={tasks.map((t) => t.id)}
          strategy={verticalListSortingStrategy}
        >
          {tasks.map((task) => (
            <BoardCard key={task.id} task={task} onMove={onMove} />
          ))}
        </SortableContext>
        {tasks.length === 0 && <div className="col-empty">—</div>}
      </div>
    </div>
  );
}
