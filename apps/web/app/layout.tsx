import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import "./globals.css";
import { CookieConsent, CookieSettingsButton } from "@/components/cookie-consent";
import { LogoutButton } from "@/components/logout-button";
import { currentUser } from "@/lib/session";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: { default: `${site.name} | Quality products, secure checkout`, template: `%s | ${site.name}` },
  description: site.description,
  applicationName: site.name,
  alternates: { canonical: "/" },
  openGraph: { type: "website", siteName: site.name, title: `${site.name} | Quality products, secure checkout`, description: site.description, url: "/", locale: "en_IN" },
  twitter: { card: "summary_large_image", title: `${site.name} | Quality products, secure checkout`, description: site.description },
  robots: { index: true, follow: true }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [{ media: "(prefers-color-scheme: light)", color: "#fafaf9" }, { media: "(prefers-color-scheme: dark)", color: "#0c0a09" }]
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [user, h] = await Promise.all([currentUser(), headers()]);
  const nonce = h.get("x-nonce") ?? undefined;
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">Skip to content</a>
        <header className="site">
          <Link href="/" className="brand">{site.name}</Link>
          <nav aria-label="Main" className="row">
            <Link href="/">Products</Link>
            {user ? (
              <>
                <Link href="/cart">Cart</Link>
                <Link href="/orders">Orders</Link>
                <span className="muted">{user.name}</span>
                <LogoutButton />
              </>
            ) : (
              <>
                <Link href="/login">Sign in</Link>
                <Link href="/register">Create account</Link>
              </>
            )}
          </nav>
        </header>
        <main id="main">{children}</main>
        <footer className="site-footer">
          <nav aria-label="Legal" className="row">
            <Link href="/privacy">Privacy policy</Link>
            <Link href="/terms">Terms &amp; conditions</Link>
            <CookieSettingsButton />
          </nav>
          <p className="muted">© {new Date().getFullYear()} {site.company}</p>
        </footer>
        <CookieConsent analyticsDomain={site.analyticsDomain} analyticsSrc={site.analyticsSrc} nonce={nonce} />
      </body>
    </html>
  );
}
