import { describe, expect, it } from "vitest";
import { rankBetween } from "../lib/rank";

describe("rankBetween", () => {
  it("generates a key between null endpoints", () => {
    const k = rankBetween(null, null);
    expect(k.length).toBeGreaterThan(0);
  });

  it("appends after a key (a < result)", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    expect(a < b).toBe(true);
  });

  it("prepends before a key (result < b)", () => {
    const b = rankBetween(null, null);
    const a = rankBetween(null, b);
    expect(a < b).toBe(true);
  });

  it("inserts strictly between two keys", () => {
    const a = rankBetween(null, null);
    const c = rankBetween(a, null);
    const mid = rankBetween(a, c);
    expect(a < mid && mid < c).toBe(true);
  });

  it("keeps ordering stable over repeated midpoint insertions", () => {
    let lo = rankBetween(null, null);
    let hi = rankBetween(lo, null);
    for (let i = 0; i < 50; i++) {
      const mid = rankBetween(lo, hi);
      expect(lo < mid && mid < hi).toBe(true);
      hi = mid; // keep subdividing the lower gap
    }
  });

  it("throws when endpoints are out of order", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    expect(() => rankBetween(b, a)).toThrow();
  });
});
