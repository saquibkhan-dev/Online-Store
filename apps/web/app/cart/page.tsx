import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { CartView } from "@/components/cart-view";
import { currentUser } from "@/lib/session";

export const metadata: Metadata = { title: "Your cart", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function CartPage() {
  if (!(await currentUser())) redirect("/login?next=/cart");
  return (
    <>
      <h1>Your cart</h1>
      <CartView />
    </>
  );
}
