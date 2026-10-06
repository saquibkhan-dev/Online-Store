import { on, Topics, type Handler } from "@commerce/shared";
import type { PaymentService } from "./payment-service";

export const consumeTopics = [Topics.orders];

export function buildHandlers(payments: PaymentService): Handler[] {
  return [on("PaymentRequested", (p, e) => payments.onPaymentRequested(p, e))];
}
