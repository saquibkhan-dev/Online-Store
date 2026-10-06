import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { formatMoney, STATUS_LABEL } from "@/lib/format";
import { currentUser, gatewayFetch } from "@/lib/session";

export const metadata: Metadata = { title: "Your orders", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

interface Summary { id: string; status: string; totalMinor: number; currency: string; createdAt: string }

export default async function OrdersPage() {
  if (!(await currentUser())) redirect("/login?next=/orders");
  const res = await gatewayFetch("/api/orders?limit=50").catch(() => null);
  const data = res?.ok ? ((await res.json()) as { items: Summary[] }) : null;
  return (
    <>
      <h1>Your orders</h1>
      {!data ? <p role="alert" className="error">We couldn't load your orders right now.</p> : data.items.length === 0 ? <p>No orders yet. <Link href="/">Start shopping</Link></p> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Order</th><th>Placed</th><th>Status</th><th>Total</th></tr></thead>
          <tbody>
            {data.items.map((o) => (
              <tr key={o.id}>
                <td><Link href={`/orders/${o.id}`}>#{o.id.slice(0, 8).toUpperCase()}</Link></td>
                <td>{new Date(o.createdAt).toLocaleString("en-IN")}</td>
                <td>{STATUS_LABEL[o.status] ?? o.status}</td>
                <td>{formatMoney(o.totalMinor, o.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </>
  );
}
