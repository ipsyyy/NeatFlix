# Security status

## Update 2026-10-19 (working tree on commit `faab683`)

### Secret scan failure resolved: false positive, nothing to rotate

`npm run demo:verify` reported "Secret material found in tracked files". The
only match was the configured `LANGSMITH_PROJECT` value (the LangSmith project
name, a public identifier and not a credential) in
`agents/observability/published.ts`, where it is committed on purpose. The
scan treated every `.env.local` value of 12+ characters as a secret.

- No credential pattern (Supabase secret, Anthropic, Google, Masky, LangSmith
  key, private key, Runway key) appears in any tracked file outside
  `agents/tests`, in the working tree or in any of the 60 commits.
- No configured secret `.env.local` value appears in any commit.
- Every key-shaped string in history is a fake fixture under `agents/tests/`
  (marked "fake", "test" or "not real", or a sequential `0123456789abcdef`
  placeholder, or far too short to be a real key).

Fix (`agents/security/secret-scan.ts`, tested in
`agents/tests/secret-scan.test.ts`): only an active `LANGSMITH_PROJECT`
assignment is skipped, by exact name. Every other value is still scanned,
including commented-out lines and publishable keys. Findings now name the
category, variable and path, never a value. Each pattern is now searched
separately with `-e` (the private-key pattern begins with dashes). Re-run:
`npm run demo:verify` passes all five checks (480/480 tests).

### Snyk remediation (2026-10-19)

Dependency change, and nothing else: `next` and `eslint-config-next` pinned
exactly to `16.4.1` (were `16.4.0`). `package-lock.json` changed only the Next.js
family: `next`, `eslint-config-next`, `@next/env`, `@next/eslint-plugin-next`,
and the `@next/swc-*` platform binaries. React (19.3.0), React DOM (19.3.0),
and TypeScript (5.9.3) are unchanged. No `npm audit fix` and no `--force`.

| Check after the upgrade | Result |
| --- | --- |
| Focused security and secret-scan tests | 32 / 32 pass |
| Lint, typecheck | Pass |
| Production build (`next build`, Next.js 16.4.1) | Pass |
| Browser tests (`npm run test:e2e`) | 5 / 5 pass |
| `npx --yes snyk@1.1308.1 test --all-projects` (production, 116 dependencies) | **Pass: no vulnerable paths** (exit 0) |
| Snyk Open Source including development dependencies (`--dev`, 518 dependencies) | 5 development-only findings (below); none in production |
| Snyk Code | Not available for this organization (HTTP 403, SNYK-CODE-0005): neither passed nor failed |
| `npm run security:audit` (`npm audit --omit=dev --audit-level=high`) | 0 vulnerabilities |
| `npm audit` including development | 5 high entries, all through `eslint-config-next` (development only) |
| `npx --yes snyk@1.1308.1 monitor --all-projects` (run once) | Exit 0: snapshots recorded for 5 projects (the app, plus four generated `.next` build manifests with no dependencies) |

#### Production findings

| Severity | Advisory | Dependency | Status |
| --- | --- | --- | --- |
| Critical | SNYK-JS-NEXT-21243979: Remote Code Execution | `next@16.4.0` (direct) | **Resolved** by `next@16.4.1`; not reported by the re-test |
| High | SNYK-JS-NEXT-21246253: Excessive Iteration | `next@16.4.0` (direct) | **Resolved** by `next@16.4.1`; not reported by the re-test |

Before the upgrade, the same Snyk test failed with these two findings (1
critical, 1 high), while `npm audit --omit=dev` reported 0 because npm's
advisory database did not list them. `npm run security:snyk` calls a bare
`snyk`, which is not on the PATH; Snyk was run through `npx` at the pinned
CLI version instead.

#### Development-only findings (lint tooling; not in the server or client bundle; unchanged by the upgrade)

| Severity | Advisory | Path | Fix |
| --- | --- | --- | --- |
| High | SNYK-JS-BRACES-19963945: Uncontrolled Recursion (also GHSA-vfj7-8cjw-p6xm, below) | `eslint-config-next@16.4.1` → `@next/eslint-plugin-next@16.4.1` → `fast-glob@3.3.1` → `braces@3.0.3` | None published |
| High | SNYK-JS-PICOMATCH-21248802: ReDoS | `eslint-config-next@16.4.1` → `@next/eslint-plugin-next@16.4.1` → `fast-glob@3.3.1` → `picomatch@2.3.2` | None published |
| High | SNYK-JS-URIJS-19963963: Infinite loop | `eslint` → `@eslint/eslintrc` → `ajv@6.15.0` → `uri-js@4.4.1` | None published |
| Medium | SNYK-JS-URIJS-19963961: Improper Encoding or Escaping of Output | same `uri-js@4.4.1` path | None published |
| Medium | SNYK-JS-URIJS-20341609: Uncaught Exception | same `uri-js@4.4.1` path | None published |

These run only when ESLint processes the project's own fixed configuration and
sources; they are accepted on the same basis as `braces` below.

---

## Review of 2026-10-17

Security milestone review of commit `032ca84` (2026-10-17).

## Snyk

Blocked (as of 2026-10-17; superseded above): the Snyk CLI was not installed
and no Snyk authentication existed, so no Snyk scan was run.

## Local scans run instead

| Scan | Result |
| --- | --- |
| `npm audit --omit=dev` (83 production packages) | 0 vulnerabilities |
| `npm audit` (521 packages including development) | 5 high entries, one advisory (below) |
| Secret patterns in tracked files and all 58 commits | Only fake test fixtures |
| Every secret `.env.local` value searched through all git history | Not found in any commit; `.env.local` is git-ignored |
| Targeted code review for common sinks | No findings (see below) |
| Security-focused test suites | 143 / 143 pass |
| Client bundle (`.next/static`) | No secrets or server-only provider references |

Code review covered: dynamic code execution (none), shell-interpreted
processes (none: `execFile`, and one `spawn` with a fixed argument list),
HTML injection (none), secrets or `process.env` in client code (none;
enforced by an ESLint rule), PostgREST query building (values URL-encoded,
limits validated, column names fixed), outbound requests (provider hosts
validated; media downloads re-check every redirect hop), TLS overrides
(none), and file writes (fixed paths or private temporary directories).

## Findings

| Severity | Finding | Location | Dependency | Reachable | Remediation | Remediation risk |
| --- | --- | --- | --- | --- | --- | --- |
| High | GHSA-vfj7-8cjw-p6xm: `braces` ≤3.0.3 stack-exhaustion denial of service through deeply nested brace patterns | `eslint-config-next@16.4.0` → `@next/eslint-plugin-next` → `fast-glob@3.3.1` → `micromatch@4.0.8` → `braces@3.0.3` | Transitive, development only (lint) | No: not in the production server or client bundle; reached only when ESLint expands NativeFrame's own fixed glob patterns | None compatible: 3.0.3 is the latest `braces` release. npm's only offer is a major downgrade of `eslint-config-next` to 14.2.35 | High: a major downgrade would break the Next.js 16 lint configuration for no runtime benefit |
| Low | No HTTP security headers (Content-Security-Policy, `frame-ancestors`/`X-Frame-Options`, `Referrer-Policy`, `X-Content-Type-Options`); `X-Powered-By` is sent | `next.config.ts` | Configuration | The deployed app serves static pages with no API routes, server actions, forms, or user input | Add `headers()` with the non-CSP headers and `poweredByHeader: false`; add a CSP compatible with Next.js inline scripts separately | Low for the non-CSP headers; a strict CSP needs testing so it does not break hydration |

## Accepted risks

- `braces` (GHSA-vfj7-8cjw-p6xm), until a patched release exists: it is
  development-only, never shipped, and its input is the project's own lint
  configuration. Re-check with `npm audit` and Snyk; upgrade as soon as a
  compatible fix is published.
