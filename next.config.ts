import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The demo reads its verified snapshot and media from .demo/ at request time.
  // Tell the deploy bundler to ship them with the demo routes (not via Git).
  outputFileTracingIncludes: {
    "/demo": ["./.demo/**/*"],
    "/demo/media/[key]": ["./.demo/**/*"],
  },
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
