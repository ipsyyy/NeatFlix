import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // The demo reads its verified snapshot and media from .demo/ at request time.
  // Tell the deploy bundler to ship them with the demo routes (not via Git).
  outputFileTracingIncludes: {
    // The catalogue checks its source clips and reads the recorded case at request time.
    "/": ["./.demo/**/*", "./public/demo-videos/*.mp4"],
    "/demo": ["./.demo/**/*"],
    "/titles/[titleId]/scenes/[sceneId]/preview": ["./public/demo-videos/luv-hypothesis-daybreak-v4.mp4"],
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
