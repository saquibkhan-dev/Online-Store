export type OrderStatus = "PENDING" | "PAYMENT_PENDING" | "CONFIRMED" | "CANCELLED";

/** Allowed order transitions; anything else is a no-op or a conflict, never a silent overwrite. */
export const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PENDING: ["PAYMENT_PENDING", "CANCELLED"],
  PAYMENT_PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: [],
  CANCELLED: []
};

export const canTransition = (from: OrderStatus, to: OrderStatus): boolean => TRANSITIONS[from].includes(to);

/** Statuses from which a customer may cancel. Confirmed (paid) orders need a refund flow, which is out of scope. */
export const USER_CANCELLABLE: readonly OrderStatus[] = ["PENDING", "PAYMENT_PENDING"];

/** Statuses that mean "waiting on something" and are subject to the timeout sweep. */
export const IN_FLIGHT: readonly OrderStatus[] = ["PENDING", "PAYMENT_PENDING"];
