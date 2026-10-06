import { on, Topics, type Handler } from "@commerce/shared";
import type { OrderService } from "./order-service";

export const consumeTopics = [Topics.inventory, Topics.payments];

export function buildHandlers(orders: OrderService): Handler[] {
  return [
    on("InventoryReserved", (p, e) => orders.onInventoryReserved(p, e)),
    on("InventoryReservationFailed", (p, e) => orders.onInventoryReservationFailed(p, e)),
    on("PaymentCompleted", (p, e) => orders.onPaymentCompleted(p, e)),
    on("PaymentFailed", (p, e) => orders.onPaymentFailed(p, e))
  ];
}
