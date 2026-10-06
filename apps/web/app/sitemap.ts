import type { MetadataRoute } from "next";
import { site } from "@/lib/site";

// Read SITE_URL at request time, not build time, so the same image works for every environment.
export const dynamic = "force-dynamic";

// Only public, indexable pages. Private pages (cart, orders, login) are excluded and carry noindex.
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date("2026-10-04");
  return [
    { url: `${site.url}/`, lastModified, changeFrequency: "daily", priority: 1 },
    { url: `${site.url}/register`, lastModified, changeFrequency: "yearly", priority: 0.5 },
    { url: `${site.url}/privacy`, lastModified, changeFrequency: "yearly", priority: 0.3 },
    { url: `${site.url}/terms`, lastModified, changeFrequency: "yearly", priority: 0.3 }
  ];
}
