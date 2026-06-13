import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { intakeApi, taskApi } from "../api/client";
import { qk } from "../api/events";
import { PRIORITIES, type Label, type Priority } from "../api/types";
import { Modal } from "./Modal";

function parseLabels(text: string): Label[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf(":");
      if (idx === -1) return null;
      return { key: pair.slice(0, idx).trim(), value: pair.slice(idx + 1).trim() };
    })
    .filter((l): l is Label => !!l && !!l.key && !!l.value);
}

function labelsToRecord(labels: Label[]): Record<string, string> {
  return Object.fromEntries(labels.map((l) => [l.key, l.value]));
}

// ─────────────────────────────── New task ─────────────────────────────
export function NewTaskModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<Priority | "">("");
  const [labelsText, setLabelsText] = useState("");

  const create = useMutation({
    mutationFn: () =>
      taskApi.create({
        title: title.trim(),
        body: body.trim() || undefined,
        priority: priority || undefined,
        labels: parseLabels(labelsText),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.board() });
      void qc.invalidateQueries({ queryKey: ["task", "list"] });
      onClose();
    },
  });

  return (
    <Modal title="New task" onClose={onClose}>
      <form
        className="form"
        data-testid="new-task-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) create.mutate();
        }}
      >
        <label className="field">
          <span>Title</span>
          <input
            value={title}
            data-testid="task-title"
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="field">
          <span>Body</span>
          <textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
        <div className="row">
          <label className="field">
            <span>Priority</span>
            <select value={priority} onChange={(e) => setPriority(e.target.value as Priority | "")}>
              <option value="">—</option>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="field grow">
            <span>Labels (key:value, comma-separated)</span>
            <input value={labelsText} onChange={(e) => setLabelsText(e.target.value)} placeholder="project:tq" />
          </label>
        </div>
        {create.error && <div className="error-banner small">{(create.error as Error).message}</div>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!title.trim() || create.isPending} data-testid="task-submit">
            {create.isPending ? "Creating…" : "Create task"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─────────────────────────────── New intake (capture) ─────────────────
export function NewIntakeModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [labelsText, setLabelsText] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      intakeApi.createMultipart({
        text: text.trim() || undefined,
        labels: labelsToRecord(parseLabels(labelsText)),
        images,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["intake", "list"] });
      void qc.invalidateQueries({ queryKey: qk.health() });
      onClose();
    },
  });

  const addFiles = (files: FileList | File[]) => {
    const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (imgs.length) setImages((prev) => [...prev, ...imgs]);
  };

  const canSubmit = (text.trim() || images.length > 0) && !create.isPending;

  return (
    <Modal title="Capture intake" onClose={onClose}>
      <form
        className="form"
        data-testid="new-intake-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) create.mutate();
        }}
      >
        <label className="field">
          <span>Text</span>
          <textarea
            rows={5}
            value={text}
            data-testid="intake-text"
            autoFocus
            placeholder="Paste anything — a note, a link, a thought…"
            onChange={(e) => setText(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files);
              if (files.length) addFiles(files);
            }}
          />
        </label>

        <div
          className={`dropzone${dragOver ? " dropzone-over" : ""}`}
          data-testid="dropzone"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            addFiles(e.dataTransfer.files);
          }}
        >
          {images.length === 0 ? (
            <span>Drop or paste screenshots here</span>
          ) : (
            <div className="thumbs">
              {images.map((img, i) => (
                <div key={i} className="thumb">
                  <img src={URL.createObjectURL(img)} alt={img.name} />
                  <button
                    type="button"
                    className="thumb-x"
                    aria-label="remove image"
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <label className="field">
          <span>Labels (key:value, comma-separated)</span>
          <input value={labelsText} onChange={(e) => setLabelsText(e.target.value)} placeholder="project:tq, area:ui" />
        </label>

        {create.error && <div className="error-banner small">{(create.error as Error).message}</div>}
        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={!canSubmit} data-testid="intake-submit">
            {create.isPending ? "Capturing…" : "Capture"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}
