import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

// Read SITE_URL at request time, not build time, so the same image works for every environment.
export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/cart", "/orders", "/login", "/bff/", "/auth/", "/dev/", "/api/"] }],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url
  };
}
