import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { AddToCart } from "@/components/add-to-cart";
import { formatMoney } from "@/lib/format";
import { API_URL, currentUser } from "@/lib/session";
import { site } from "@/lib/site";

export const dynamic = "force-dynamic";

export async function generateMetadata({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }): Promise<Metadata> {
  const { q, page } = await searchParams;
  if (q) return { title: `Search results for “${q.slice(0, 60)}”`, robots: { index: false, follow: true }, alternates: { canonical: "/" } };
  if (page && page !== "1") return { title: `Products, page ${Number.parseInt(page, 10) || 1}`, alternates: { canonical: `/?page=${Number.parseInt(page, 10) || 1}` } };
  return {};
}

interface Product { id: string; name: string; description: string; priceMinor: number; currency: string; category: { name: string } | null }
interface Page { items: Product[]; total: number; page: number; limit: number }

async function load(search: string, page: number): Promise<Page | null> {
  const qs = new URLSearchParams({ page: String(page), limit: "12", ...(search ? { search } : {}) });
  try {
    const res = await fetch(`${API_URL}/api/products?${qs}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as Page) : null;
  } catch {
    return null;
  }
}

export default async function Home({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  const { q = "", page: p = "1" } = await searchParams;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(p, 10) || 1));
  const [data, user] = await Promise.all([load(q.slice(0, 100), page), currentUser()]);
  const pages = data ? Math.max(1, Math.ceil(data.total / data.limit)) : 1;
  const link = (n: number) => `/?${new URLSearchParams({ ...(q ? { q } : {}), page: String(n) })}`;

  const hero = !q && page === 1;
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  const jsonLd = JSON.stringify({ "@context": "https://schema.org", "@type": "WebSite", name: site.name, url: site.url }).replace(/</g, "\\u003c");
  return (
    <>
      <script type="application/ld+json" nonce={nonce} dangerouslySetInnerHTML={{ __html: jsonLd }} />
      {hero && (
        <section className="hero" aria-labelledby="hero-title">
          <h1 id="hero-title">Quality products, delivered with care</h1>
          <p className="muted">Secure checkout and live order tracking, from cart to confirmation.</p>
          {user ? <Link className="btn primary" href="/cart">View your cart</Link> : <Link className="btn primary" href="/register">Create your free account</Link>}
        </section>
      )}
      {hero ? <h2 id="products">Products</h2> : <h1 id="products">{q ? "Search results" : "Products"}</h1>}
      <form role="search" className="row" action="/" style={{ marginBottom: "1rem" }}>
        <label className="sr-only" htmlFor="q">Search products</label>
        <input id="q" name="q" type="search" defaultValue={q} placeholder="Search products" maxLength={100} />
        <button>Search</button>
      </form>
      {!data ? (
        <p role="alert" className="error">We couldn't load products right now. Please try again in a moment.</p>
      ) : data.items.length === 0 ? (
        <p>{q ? `No products match “${q}”.` : "No products yet."}</p>
      ) : (
        <ul className="grid">
          {data.items.map((product) => (
            <li key={product.id} className="card">
              {product.category && <span className="muted">{product.category.name}</span>}
              <strong>{product.name}</strong>
              <span className="muted">{product.description.slice(0, 120)}</span>
              <span className="price">{formatMoney(product.priceMinor, product.currency)}</span>
              <AddToCart productId={product.id} name={product.name} signedIn={Boolean(user)} />
            </li>
          ))}
        </ul>
      )}
      {data && pages > 1 && (
        <nav aria-label="Pagination" className="row">
          {page > 1 && <Link className="btn" href={link(page - 1)}>Previous</Link>}
          <span className="muted">Page {page} of {pages}</span>
          {page < pages && <Link className="btn" href={link(page + 1)}>Next</Link>}
        </nav>
      )}
    </>
  );
}
