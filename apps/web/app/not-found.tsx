import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Page not found", robots: { index: false, follow: false } };

export default function NotFound() {
  return (
    <section className="center-block">
      <p className="muted" aria-hidden="true">404</p>
      <h1>We can't find that page</h1>
      <p>The link may be broken or the page may have moved. Here are some places to go next:</p>
      <p className="row">
        <Link className="btn primary" href="/">Browse products</Link>
        <Link className="btn" href="/orders">Your orders</Link>
      </p>
    </section>
  );
}
