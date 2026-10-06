import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { OrderTracker, type Order } from "@/components/order-tracker";
import { currentUser, gatewayFetch } from "@/lib/session";

export const metadata: Metadata = { title: "Order details", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await currentUser())) redirect(`/login?next=/orders/${encodeURIComponent(id)}`);
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const res = await gatewayFetch(`/api/orders/${id}`).catch(() => null);
  if (!res || res.status === 404) notFound();
  if (!res.ok) throw new Error("order lookup failed");
  const order = (await res.json()) as Order;
  return (
    <>
      <h1>Order #{id.slice(0, 8).toUpperCase()}</h1>
      <OrderTracker initial={order} sandbox={process.env.SANDBOX_PAYMENTS === "true"} />
    </>
  );
}
