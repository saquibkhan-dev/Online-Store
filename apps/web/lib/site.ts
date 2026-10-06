// Server-side only (read at runtime, never bundled to the browser). Everything here is public-facing content,
// not a secret, but it is configured per deployment rather than hard-coded.
const trim = (v: string | undefined, fallback: string) => (v && v.trim() ? v.trim() : fallback);

export const site = {
  name: trim(process.env.SITE_NAME, "Shop"),
  company: trim(process.env.COMPANY_NAME, "Shop"),
  url: trim(process.env.SITE_URL, "http://localhost:8080").replace(/\/$/, ""),
  contactEmail: trim(process.env.CONTACT_EMAIL, "support@example.com"),
  governingLaw: trim(process.env.GOVERNING_LAW, "India"),
  description: "Browse quality products and check out securely. Fast delivery updates and easy order tracking.",
  // Optional privacy-friendly analytics (Plausible-compatible). Disabled unless ANALYTICS_DOMAIN is set.
  analyticsDomain: process.env.ANALYTICS_DOMAIN?.trim() || undefined,
  analyticsSrc: trim(process.env.ANALYTICS_SCRIPT_URL, "https://plausible.io/js/script.js")
};
