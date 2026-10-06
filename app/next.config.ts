import path from "node:path";
import type { NextConfig } from "next";

// The monorepo root: `@epoch/epoch-sdk` is a workspace package outside app/, so the bundler's root must include it.
const monorepoRoot = path.join(__dirname, "..");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: { root: monorepoRoot },
  outputFileTracingRoot: monorepoRoot,
  // One short link per sponsor side track, for the submission forms.
  async redirects() {
    return [
      { source: "/solami", destination: "/live", permanent: false },
      { source: "/panta", destination: "/predict", permanent: false },
      { source: "/meteora", destination: "/launch", permanent: false },
    ];
  },
};

export default nextConfig;
