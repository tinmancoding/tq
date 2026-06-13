import { uuidv7 } from "uuidv7";

/** Generate a sortable, unique id (uuidv7 text). */
export function newId(): string {
  return uuidv7();
}

/** Current timestamp as ISO-8601 UTC text. */
export function now(): string {
  return new Date().toISOString();
}
