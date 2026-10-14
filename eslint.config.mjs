import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Agent runtime code and credentials are server-only and must never enter the Next.js bundle.
  {
    files: ["app/**", "components/**", "lib/**", "data/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@/agents", "@/agents/*", "**/agents/*"], message: "agents/ is server-only runtime code." },
            { group: ["@band-ai/*", "@anthropic-ai/*"], message: "Agent SDKs are server-only; use them from agents/." },
          ],
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
