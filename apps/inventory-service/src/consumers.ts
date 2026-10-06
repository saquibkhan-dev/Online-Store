import { on, Topics, type Handler } from "@commerce/shared";
import type { InventoryService } from "./inventory-service";

export const consumeTopics = [Topics.orders];

export function buildHandlers(inventory: InventoryService): Handler[] {
  return [
    on("OrderCreated", (payload, envelope) => inventory.reserveForOrder(payload, envelope)),
    on("OrderConfirmed", (payload, envelope) => inventory.confirmForOrder(payload.orderId, envelope)),
    on("OrderCancelled", (payload, envelope) => inventory.releaseForOrder(payload.orderId, envelope))
  ];
}
