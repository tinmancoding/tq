import { describe, it, expect } from "vitest";
import { PRIORITIES as CORE_PRIORITIES, TASK_STATUSES as CORE_STATUSES } from "@tq/core";
import { PRIORITIES as WIRE_PRIORITIES, TASK_STATUSES as WIRE_STATUSES } from "@tq/contract";

/**
 * Staleness gate (Q6): the daemon bridges core's domain enums to the wire
 * contract, so the two MUST agree. If someone adds a status to core without
 * updating @tq/contract (or vice-versa), this fails before clients drift.
 */
describe("contract <-> core enum parity", () => {
  it("task statuses agree", () => {
    expect([...WIRE_STATUSES]).toEqual([...CORE_STATUSES]);
  });
  it("priorities agree", () => {
    expect([...WIRE_PRIORITIES]).toEqual([...CORE_PRIORITIES]);
  });
});
