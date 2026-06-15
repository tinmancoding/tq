import type { DB } from "./db/sqlite.js";
import { openDb, type OpenDbOptions } from "./db/sqlite.js";
import { EventBus } from "./events.js";
import { TaskRepo } from "./domain/task.js";
import { IntakeRepo } from "./domain/intake.js";
import { JobRepo } from "./domain/job.js";
import { AttachmentRepo } from "./domain/attachment.js";
import { EventStore } from "./domain/event.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface StoreOptions extends OpenDbOptions {
  /** Directory for the content-addressed attachment blob store. */
  attachmentsDir?: string;
}

/**
 * The Store wires the database and repositories together with a shared event
 * bus. The daemon constructs one Store; tests construct one per case.
 */
export class Store {
  readonly db: DB;
  readonly bus: EventBus;
  readonly events: EventStore;
  readonly tasks: TaskRepo;
  readonly intake: IntakeRepo;
  readonly jobs: JobRepo;
  readonly attachments: AttachmentRepo;

  constructor(db: DB, opts: { bus?: EventBus; attachmentsDir?: string } = {}) {
    this.db = db;
    this.bus = opts.bus ?? new EventBus();
    this.events = new EventStore(db);
    this.tasks = new TaskRepo(db, this.bus, this.events);
    this.intake = new IntakeRepo(db, this.bus, this.tasks, this.events);
    this.jobs = new JobRepo(db, this.bus);
    this.attachments = new AttachmentRepo(
      db,
      opts.attachmentsDir ?? join(tmpdir(), "tq-attachments"),
    );
  }

  static open(opts: StoreOptions, bus?: EventBus): Store {
    return new Store(openDb(opts), { bus, attachmentsDir: opts.attachmentsDir });
  }

  close(): void {
    this.db.close();
  }
}
