# Contributing

Use the [README](README.md) to start a local account. Read the [architecture](docs/architecture.md), [PRD](prd.md), and relevant [decision records](docs/decisions/) before changing financial authority or execution behavior.

## Development checks

Use the Node version in `.nvmrc` and the pnpm version in `package.json`. Install with `pnpm install --frozen-lockfile`.

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:property
pnpm test:contracts
pnpm build
```

Database, fault, and browser suites use PostgreSQL and a disposable test database through `DATABASE_URL_TEST`. Run these suites sequentially because they share state:

```bash
pnpm test:integration
pnpm test:fault
pnpm exec playwright install chromium
pnpm test:e2e
```

Do not point tests at an operational account database. Browser tests start their own kernel and console; keep their configured ports free.

## Changes and pull requests

Keep patches focused. Describe the behavior before and after the change, provide relevant verification, and update the documentation when behavior changes. Add regression coverage for financial authority, idempotency, accounting, and failure recovery. Keep REPLAY fixtures, SHADOW observations, and external exchange effects explicitly distinguished in tests and evidence.

All financial values cross API boundaries as decimal strings. Agents must never gain operator credentials, enlarge their own leases, approve their own requests, or bypass the deterministic evaluator. Preserve the single-writer boundary and durable command identity across retries and restarts.

Never commit `.env`, agent tokens, operator bootstrap secrets, database backups, or raw provider captures. New public evidence must pass the export verifier and a secret review. A fixture or paper fill is not proof of an external exchange order.

Contributions are provided under the repository's [MIT license](LICENSE). See [SECURITY.md](SECURITY.md) for vulnerability reporting.
