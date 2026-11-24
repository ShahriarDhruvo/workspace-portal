import path from "node:path";
import type { NextConfig } from "next";
import { LLM_API_BODY_BYTES } from "./lib/limits.ts";

const repoRoot = path.join(import.meta.dirname, "..");

const securityHeaders = [
  // The portal itself is never framed; only the workspace ports (one per workspace, served by the gateway) are.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  transpilePackages: ["@portal/core"],
  poweredByHeader: false,
  // Next.js cuts a request body off at 10 MB; the LLM API (app/llm/api) passes on what the LLM server takes.
  experimental: { proxyClientMaxBodySize: LLM_API_BODY_BYTES },
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
