"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { formatMoney } from "@/lib/format";
import { api, ApiError } from "./api";
import { useDebouncedCallback } from "./use-debounce";

interface Line { id: string; productId: string; quantity: number; product: { name: string; unitPriceMinor: number; currency: string } | null; lineTotalMinor: number | null }
interface Cart { items: Line[]; subtotalMinor: number | null }

// Memoised so editing one quantity does not re-render every other row. The typed value is local state and is only
// sent to the server after a short pause, instead of firing a request per keystroke.
const CartRow = memo(function CartRow({ line, busy, onQuantity, onRemove, onDirty }: {
  line: Line; busy: boolean; onQuantity: (id: string, quantity: number) => void; onRemove: (id: string) => void; onDirty: (id: string, dirty: boolean) => void;
}) {
  const [qty, setQty] = useState(String(line.quantity));
  useEffect(() => setQty(String(line.quantity)), [line.quantity]);
  const commit = useDebouncedCallback((quantity: number) => { onDirty(line.id, false); onQuantity(line.id, quantity); }, 600);
  return (
    <tr>
      <td>{line.product?.name ?? "Unavailable item"}</td>
      <td>
        <label className="sr-only" htmlFor={`q-${line.id}`}>Quantity</label>
        <input id={`q-${line.id}`} type="number" inputMode="numeric" min={1} max={20} value={qty} className="qty"
          onChange={(e) => {
            setQty(e.target.value);
            const quantity = Number(e.target.value);
            if (Number.isInteger(quantity) && quantity >= 1 && quantity <= 20 && quantity !== line.quantity) { onDirty(line.id, true); commit(quantity); }
          }} />
      </td>
      <td>{line.lineTotalMinor === null ? "—" : formatMoney(line.lineTotalMinor, line.product?.currency)}</td>
      <td><button disabled={busy} onClick={() => onRemove(line.id)}>Remove</button></td>
    </tr>
  );
});

export function CartView() {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  // One idempotency key per checkout *attempt*: retrying after a timeout reuses it, so no double orders.
  const attemptKey = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCart(await api<Cart>("/bff/api/cart"));
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load your cart");
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const change = useCallback(async (run: () => Promise<unknown>) => {
    attemptKey.current = null; // the cart is changing, so the next checkout is a new attempt
    setBusy(true);
    try {
      await run();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }, [load]);

  const onQuantity = useCallback((id: string, quantity: number) => void change(() => api(`/bff/api/cart/items/${id}`, { method: "PATCH", body: JSON.stringify({ quantity }) })), [change]);
  const onRemove = useCallback((id: string) => void change(() => api(`/bff/api/cart/items/${id}`, { method: "DELETE" })), [change]);
  const onDirty = useCallback((id: string, isDirty: boolean) => setDirty((prev) => {
    if (prev.has(id) === isDirty) return prev;
    const next = new Set(prev);
    if (isDirty) next.add(id); else next.delete(id);
    return next;
  }), []);

  async function checkout() {
    attemptKey.current ??= `ck-${crypto.randomUUID()}`;
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ orderId: string }>("/bff/api/checkout", { method: "POST", headers: { "idempotency-key": attemptKey.current } });
      attemptKey.current = null;
      router.push(`/orders/${res.orderId}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Checkout failed");
      setBusy(false);
    }
  }

  if (!cart) return <p role="status">{error ?? "Loading your cart…"}</p>;
  if (cart.items.length === 0) return <p>Your cart is empty. <Link href="/">Browse products</Link></p>;
  const canCheckout = cart.items.every((l) => l.product) && !busy && dirty.size === 0;

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th><span className="sr-only">Remove</span></th></tr></thead>
          <tbody>
            {cart.items.map((l) => <CartRow key={l.id} line={l} busy={busy} onQuantity={onQuantity} onRemove={onRemove} onDirty={onDirty} />)}
          </tbody>
        </table>
      </div>
      <p className="row between">
        <strong>Subtotal {cart.subtotalMinor === null ? "—" : formatMoney(cart.subtotalMinor, cart.items[0]?.product?.currency)}</strong>
        <button className="primary" disabled={!canCheckout} onClick={checkout}>{busy ? "Working…" : "Place order"}</button>
      </p>
      <p role="alert" className="error">{error}</p>
    </>
  );
}
