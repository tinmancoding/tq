import { useState } from "react";
import { Modal } from "./Modal";

export function CreateWorkspaceModal({
  defaultName,
  onClose,
  onCreate,
}: {
  defaultName: string;
  onClose: () => void;
  onCreate: (input: { provider: string; name: string; template?: string }) => void;
}) {
  const [provider, setProvider] = useState("tasktree");
  const [name, setName] = useState(defaultName);
  const [template, setTemplate] = useState("");

  const command =
    provider === "tasktree"
      ? template
        ? `tasktree init --from ${template} --name ${name} --annotate tq.task-id=…`
        : `tasktree init ${name}`
      : `mkdir ${name}`;

  return (
    <Modal title="Create workspace" onClose={onClose}>
      <form
        className="ws-form"
        onSubmit={(e) => {
          e.preventDefault();
          onCreate({ provider, name: name.trim() || defaultName, template: template.trim() || undefined });
        }}
      >
        <label className="field">
          <span>Provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value)} data-testid="ws-provider">
            <option value="tasktree">tasktree</option>
            <option value="local">local</option>
          </select>
        </label>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} data-testid="ws-name" />
        </label>
        {provider === "tasktree" && (
          <label className="field">
            <span>Template (optional)</span>
            <input
              value={template}
              placeholder="e.g. aibm-general (blank = empty init)"
              onChange={(e) => setTemplate(e.target.value)}
              data-testid="ws-template"
            />
          </label>
        )}
        <pre className="ws-command" data-testid="ws-command">{command}</pre>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" data-testid="ws-create-submit">
            Create
          </button>
        </div>
      </form>
    </Modal>
  );
}
