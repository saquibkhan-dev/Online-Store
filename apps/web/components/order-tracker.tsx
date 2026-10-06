"use client";
import { useCallback, useEffect, useState } from "react";
import { formatMoney, isTerminal, STATUS_LABEL } from "@/lib/format";
import { api, ApiError } from "./api";

export interface Order {
  id: string; status: string; totalMinor: number; currency: string; cancelReason: string | null;
  items: Array<{ productId: string; productName: string; unitPriceMinor: number; quantity: number; lineTotalMinor: number }>;
}

/** Orders finish asynchronously (stock, payment), so the page polls until a terminal state. */
export function OrderTracker({ initial, sandbox }: { initial: Order; sandbox: boolean }) {
  const [order, setOrder] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setOrder(await api<Order>(`/bff/api/orders/${initial.id}`));
    } catch { /* transient; the next poll retries */ }
  }, [initial.id]);

  useEffect(() => {
    if (isTerminal(order.status)) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [order.status, refresh]);

  async function act(run: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await run();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const cancellable = order.status === "PENDING" || order.status === "PAYMENT_PENDING";
  return (
    <>
      <p>
        Status: <span className="pill" role="status" aria-live="polite">{STATUS_LABEL[order.status] ?? order.status}</span>
        {order.cancelReason && <span className="muted"> ({order.cancelReason.toLowerCase().replaceAll("_", " ")})</span>}
      </p>
      <div className="table-wrap"><table>
        <thead><tr><th>Item</th><th>Qty</th><th>Total</th></tr></thead>
        <tbody>
          {order.items.map((i) => (
            <tr key={i.productId}><td>{i.productName}</td><td>{i.quantity}</td><td>{formatMoney(i.lineTotalMinor, order.currency)}</td></tr>
          ))}
        </tbody>
      </table></div>
      <p><strong>Total {formatMoney(order.totalMinor, order.currency)}</strong></p>
      <div className="row">
        {sandbox && order.status === "PAYMENT_PENDING" && (
          <>
            <button className="primary" disabled={busy} onClick={() => void act(() => api(`/dev/pay/${order.id}`, { method: "POST", body: JSON.stringify({ outcome: "succeeded" }) }))}>Simulate successful payment</button>
            <button disabled={busy} onClick={() => void act(() => api(`/dev/pay/${order.id}`, { method: "POST", body: JSON.stringify({ outcome: "failed" }) }))}>Simulate declined payment</button>
          </>
        )}
        {cancellable && <button disabled={busy} onClick={() => void act(() => api(`/bff/api/orders/${order.id}/cancel`, { method: "POST" }))}>Cancel order</button>}
      </div>
      {sandbox && <p className="muted">Sandbox mode: there is no real payment provider, so use the buttons above to play the provider.</p>}
      <p role="alert" className="error">{error}</p>
    </>
  );
}
