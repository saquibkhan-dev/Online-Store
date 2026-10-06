import { describe, expect, it } from "vitest";
import { canTransition, TRANSITIONS, type OrderStatus } from "../src/state";

describe("order state machine", () => {
  it("allows only the documented transitions", () => {
    expect(canTransition("PENDING", "PAYMENT_PENDING")).toBe(true);
    expect(canTransition("PAYMENT_PENDING", "CONFIRMED")).toBe(true);
    expect(canTransition("PENDING", "CONFIRMED")).toBe(false);
  });
  it("treats CONFIRMED and CANCELLED as terminal", () => {
    for (const s of ["CONFIRMED", "CANCELLED"] as OrderStatus[]) expect(TRANSITIONS[s]).toEqual([]);
  });
});
