import { on, Topics, type Handler } from "@commerce/shared";
import type { NotificationService } from "./notification-service";

export const consumeTopics = [Topics.orders];

export function buildHandlers(n: NotificationService): Handler[] {
  return [
    on("OrderConfirmed", (p, e) => n.onOrderConfirmed(p, e)),
    on("OrderCancelled", (p, e) => n.onOrderCancelled(p, e)),
    on("NotificationRequested", (p, e) => n.onNotificationRequested(p, e))
  ];
}
