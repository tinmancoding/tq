import type Database from "better-sqlite3";
import type { EventBus } from "../events.js";
import type { EventStore } from "./event.js";
import type { AttachmentRepo } from "./attachment.js";

export type ContextScope = "task" | "intake";

// Whitelist: the only tables that carry a `context` column. Used to safely
// interpolate the table name (never from user input).
const SCOPE_TABLES: Record<ContextScope, string> = { task: "task", intake: "intake" };

/** Claim-check envelope stored in place of an over-threshold value. */
export interface ContextRef {
  $ref: string; // "blob:sha256:<sha>"
  bytes: number;
  encoding: "json";
}

export interface SetContextResult {
  context: Record<string, unknown>;
  spilled: boolean;
}

/**
 * The per-entity context store (Q3). `set` replaces a single namespace slot on
 * the entity's `context` bag — never deep-merging, never touching other
 * namespaces, so concurrent extensions can't clobber each other. Values larger
 * than `spillBytes` are written to the content-addressed blob store and a
 * `{$ref}` is stored instead (claim-check). Every set appends a `ContextUpdated`
 * event in the same transaction that folds the column.
 */
export class ContextRepo {
  constructor(
    private readonly db: Database.Database,
    private readonly bus: EventBus,
    private readonly events: EventStore,
    private readonly blobs: AttachmentRepo,
    private readonly spillBytes: number,
  ) {}

  /** Merged context bag for an entity, or null if the entity doesn't exist. */
  get(scope: ContextScope, id: string): Record<string, unknown> | null {
    const row = this.db
      .prepare(`SELECT context FROM ${SCOPE_TABLES[scope]} WHERE id = ?`)
      .get(id) as { context: string } | undefined;
    if (!row) return null;
    return parseBag(row.context);
  }

  /** Resolve a single namespace's value, dereferencing a spilled claim-check
   *  blob back into its JSON value. */
  getValue(scope: ContextScope, id: string, namespace: string): unknown {
    const bag = this.get(scope, id);
    if (!bag) return null;
    const v = bag[namespace];
    if (v && typeof v === "object" && "$ref" in (v as object)) {
      const sha = (v as ContextRef).$ref.split(":")[2];
      if (!sha) return null;
      const b64 = this.blobs.readBase64(sha);
      if (!b64) return null;
      try {
        return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
      } catch {
        return null;
      }
    }
    return v ?? null;
  }

  set(
    scope: ContextScope,
    id: string,
    namespace: string,
    value: unknown,
    actor: string,
  ): SetContextResult | null {
    const current = this.get(scope, id);
    if (current === null) return null;

    const serialized = JSON.stringify(value ?? null);
    const size = Buffer.byteLength(serialized, "utf8");
    let stored: unknown = value ?? null;
    let spilled = false;
    if (size > this.spillBytes) {
      const sha = this.blobs.store(Buffer.from(serialized, "utf8"), { mime: "application/json" });
      stored = { $ref: `blob:sha256:${sha}`, bytes: size, encoding: "json" } satisfies ContextRef;
      spilled = true;
    }

    const next = { ...current, [namespace]: stored };
    const tx = this.events.transaction(() => {
      this.db
        .prepare(`UPDATE ${SCOPE_TABLES[scope]} SET context = ? WHERE id = ?`)
        .run(JSON.stringify(next), id);
      this.events.append({
        type: "ContextUpdated",
        scopeType: scope,
        scopeId: id,
        actor,
        payload: { namespace, value: stored },
      });
    });
    tx();
    return { context: next, spilled };
  }
}

function parseBag(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
