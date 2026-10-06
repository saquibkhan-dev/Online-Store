import path from "node:path";
import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "X-DNS-Prefetch-Control", value: "off" }
];

const config: NextConfig = {
  output: "standalone",
  // Monorepo: trace dependencies from the repo root so the standalone bundle includes hoisted packages.
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  // Serve /_next/static from a CDN by setting CDN_URL at build time (e.g. https://cdn.example.com).
  assetPrefix: process.env.CDN_URL || undefined,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  }
};

export default config;
