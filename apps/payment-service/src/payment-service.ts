import { Errors, outboxRecord, type EventEnvelope, type EventPayload, type Logger } from "@commerce/shared";
import { z } from "zod";
import type { Db } from "./db";
import { claimEvent, enqueue } from "./outbox";

export const CONSUMER = "payment-service";

export const webhookSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.enum(["payment.succeeded", "payment.failed"]),
  data: z.object({
    orderId: z.string().uuid(),
    reference: z.string().min(1).max(128),
    amountMinor: z.number().int().nonnegative(),
    currency: z.string().length(3),
    reason: z.string().max(200).optional()
  })
});
export type WebhookEvent = z.infer<typeof webhookSchema>;

export type WebhookOutcome = "processed" | "duplicate" | "ignored" | "needs_review";

export class PaymentService {
  constructor(private readonly db: Db, private readonly logger: Logger) {}

  /** Order service asked us to collect money: create the payment record (one per order). */
  async onPaymentRequested(p: EventPayload<"PaymentRequested">, env: EventEnvelope): Promise<void> {
    await this.db.$transaction(async (tx) => {
      if (!(await claimEvent(tx, env.eventId, CONSUMER))) return;
      await tx.payment.createMany({
        data: [{ id: p.paymentId, orderId: p.orderId, amountMinor: p.amountMinor, currency: p.currency, correlationId: env.correlationId }],
        skipDuplicates: true
      });
    });
  }

  /**
   * Applies a verified provider webhook. Safe to call repeatedly with the same provider event id.
   * If the matching payment record does not exist yet (webhook beat our own event), it throws a retryable
   * error and the transaction, including the dedupe row, rolls back so the provider's retry is processed.
   */
  async handleWebhook(event: WebhookEvent): Promise<WebhookOutcome> {
    return this.db.$transaction(async (tx) => {
      const seen = await tx.webhookEvent.createMany({ data: [{ providerEventId: event.id, type: event.type }], skipDuplicates: true });
      if (seen.count === 0) return "duplicate";

      const payment = await tx.payment.findUnique({ where: { orderId: event.data.orderId } });
      if (!payment) throw Errors.conflict("PAYMENT_NOT_READY", "No payment is expected for this order yet; retry later");
      if (payment.status !== "PENDING") {
        this.logger.info({ orderId: payment.orderId, status: payment.status }, "webhook for a payment that is already settled");
        return "ignored";
      }

      const meta = { aggregateId: payment.orderId, correlationId: payment.correlationId };
      if (event.type === "payment.failed") {
        const reason = event.data.reason ?? "provider_declined";
        await tx.payment.update({ where: { id: payment.id }, data: { status: "FAILED", failureReason: reason, providerReference: event.data.reference } });
        await enqueue(tx, outboxRecord("PaymentFailed", { orderId: payment.orderId, paymentId: payment.id, reason }, meta));
        return "processed";
      }

      if (event.data.amountMinor !== payment.amountMinor || event.data.currency !== payment.currency) {
        // Money moved but not the amount we asked for. Never auto-complete; a human reconciles it.
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: "REQUIRES_REVIEW", failureReason: "AMOUNT_MISMATCH", providerReference: event.data.reference }
        });
        this.logger.error(
          { orderId: payment.orderId, expected: payment.amountMinor, received: event.data.amountMinor, reference: event.data.reference },
          "payment amount mismatch"
        );
        return "needs_review";
      }

      await tx.payment.update({ where: { id: payment.id }, data: { status: "COMPLETED", providerReference: event.data.reference } });
      await enqueue(
        tx,
        outboxRecord(
          "PaymentCompleted",
          { orderId: payment.orderId, paymentId: payment.id, providerReference: event.data.reference, amountMinor: payment.amountMinor, currency: payment.currency },
          meta
        )
      );
      return "processed";
    });
  }
}
