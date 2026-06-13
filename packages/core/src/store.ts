import type { DB } from "./db/sqlite.js";
import { openDb, type OpenDbOptions } from "./db/sqlite.js";
import { EventBus } from "./events.js";
import { TaskRepo } from "./domain/task.js";
import { IntakeRepo } from "./domain/intake.js";
import { JobRepo } from "./domain/job.js";

/**
 * The Store wires the database and repositories together with a shared event
 * bus. The daemon constructs one Store; tests construct one per case.
 */
export class Store {
  readonly db: DB;
  readonly bus: EventBus;
  readonly tasks: TaskRepo;
  readonly intake: IntakeRepo;
  readonly jobs: JobRepo;

  constructor(db: DB, bus = new EventBus()) {
    this.db = db;
    this.bus = bus;
    this.tasks = new TaskRepo(db, bus);
    this.intake = new IntakeRepo(db, bus, this.tasks);
    this.jobs = new JobRepo(db, bus);
  }

  static open(opts: OpenDbOptions, bus?: EventBus): Store {
    return new Store(openDb(opts), bus);
  }

  close(): void {
    this.db.close();
  }
}
