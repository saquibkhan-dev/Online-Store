import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { forwardedFor } from "@/lib/client-ip";
import { isSameOrigin } from "@/lib/csrf";
import { API_URL, gatewayFetch } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * SANDBOX ONLY. Plays the payment provider by sending a correctly signed webhook for the caller's own order.
 * It is disabled unless SANDBOX_PAYMENTS=true, and production compose never sets that or passes the secret.
 */
export async function POST(req: Request, ctx: { params: Promise<{ orderId: string }> }) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (process.env.SANDBOX_PAYMENTS !== "true" || !secret) return new NextResponse(null, { status: 404 });
  if (!isSameOrigin(req.headers)) return NextResponse.json({ error: { code: "FORBIDDEN" } }, { status: 403 });
  const { orderId } = await ctx.params;
  const { outcome } = (await req.json().catch(() => ({}))) as { outcome?: string };
  if (!/^[0-9a-f-]{36}$/i.test(orderId)) return new NextResponse(null, { status: 404 });

  const orderRes = await gatewayFetch(`/api/orders/${orderId}`); // ownership enforced by the order service
  if (!orderRes.ok) return new NextResponse(null, { status: orderRes.status === 401 ? 401 : 404 });
  const order = (await orderRes.json()) as { totalMinor: number; currency: string };

  const raw = JSON.stringify({
    id: `evt_sandbox_${orderId}_${outcome === "failed" ? "f" : "s"}`,
    type: outcome === "failed" ? "payment.failed" : "payment.succeeded",
    data: { orderId, reference: `sandbox_${Date.now()}`, amountMinor: order.totalMinor, currency: order.currency, ...(outcome === "failed" ? { reason: "sandbox_declined" } : {}) }
  });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
  const res = await fetch(`${API_URL}/api/payments/webhook`, {
    method: "POST", headers: { ...forwardedFor(req.headers), "content-type": "application/json", "x-signature": `t=${t},v1=${v1}` }, body: raw, signal: AbortSignal.timeout(10_000)
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
