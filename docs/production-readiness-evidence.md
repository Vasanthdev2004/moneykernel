# Production SHADOW readiness evidence

Verified 2026-09-08 against commit worktree `codex/production-shadow` before publication.

## Runtime acceptance

| Check | Result |
|---|---|
| Formatting and static analysis | `pnpm lint` passed across 208 files |
| Type safety | `pnpm typecheck` passed |
| Deterministic tests | 284 unit, 7 property, and 90 contract tests passed |
| Database behavior | 153 integration tests passed; 3 optional tests skipped by their existing gates |
| Failure recovery | 5 fault-injection tests passed |
| Operator workflow | 7 isolated-port Chromium tests passed |
| Production web build | Passed; 425.82 kB JS / 132.62 kB gzip, 29.70 kB CSS / 6.91 kB gzip; no source-map file |
| Dependency audit | `pnpm audit --prod --audit-level high`: no known vulnerabilities |
| Compose definition | Production environment template resolves with `docker compose ... config --quiet` |

The first integration invocation inherited a stale local database port and failed authentication before running cases. The recorded database result above is the clean rerun against the repository's healthy PostgreSQL test service on port 5433.

## Final image acceptance

The final multi-stage build uses Node 24.20.0 and a digest-pinned distroless Debian 13 runtime. The resulting Linux image is about 70 MB, runs as UID/GID `65532:65532`, and contains no shell or package manager.

The image was run with a read-only root filesystem, a writable state volume, no Linux capabilities, and `no-new-privileges`. Against a migrated PostgreSQL database it demonstrated:

- one successful pristine SHADOW bootstrap from the reviewed JSON profile;
- `GET /health/ready` returning `200 {"ready":true}` without internal check details;
- the built console returning 200 with the production Content Security Policy;
- hashed assets using immutable caching;
- source-map requests returning 404;
- a foreign browser Origin being rejected with 403 before login;
- authorized Prometheus metrics reporting ready and zero unknown commands;
- the migration runner reporting five applied migrations, zero pending, and zero drift.

Docker Scout v1.24.0 indexed 119 packages in the final image and reported 0 critical or high vulnerabilities in the severity-filtered scan using its 2026-09-08 advisory database. That scan does not establish the absence of medium or low findings. This scan is point-in-time evidence; Dependabot tracks npm, GitHub Actions, and container updates after merge.

## Claim boundary

This evidence qualifies the supplied private, single-instance SHADOW topology. SHADOW uses live public market reads and virtual execution. It does not qualify Binance Spot Testnet writes, mainnet funds, hot failover, or an externally anchored audit log. The forbidden mainnet and bypass environment keys still abort startup.
