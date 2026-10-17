# Security status

Security milestone review of commit `032ca84` (2026-10-17).

## Snyk

Blocked: the Snyk CLI is not installed and no Snyk authentication exists (no
`SNYK_TOKEN`, no Snyk CLI configuration). Authentication needs an interactive
login by the account owner, so no Snyk scan has been run.

To run it later (read-only tests only; never `snyk monitor`):

1. Install a vetted, pinned Snyk CLI version, then authenticate: `snyk auth`
   (or set `SNYK_TOKEN` in the shell, never in a committed file).
2. `npm run security:snyk`: Snyk Open Source (`snyk test --all-projects`)
   and Snyk Code (`snyk code test`), failing on high or critical findings.
   Snyk Code uploads source for analysis and needs an account plan that
   includes it.

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
