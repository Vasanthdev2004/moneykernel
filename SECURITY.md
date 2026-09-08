# Security policy

MoneyKernel's maintained release boundary is the current `main` branch and its private, single-instance SHADOW deployment. REPLAY and SHADOW use virtual funds. Testnet execution is unqualified, and mainnet execution is absent. See the [deployment runbook](docs/production-shadow.md) for supported operating conditions.

## Authority and deployment boundaries

- Model output cannot change policy, grant approval, issue leases, or arm an order. The strategy process receives no exchange credentials, operator session, or writable database connection.
- Secrets belong in a private environment or secret store. `.env` and operational state are gitignored.
- Production configuration requires an HTTPS origin, separate strong operator and metrics secrets, and bounded request rates. Browser mutations require same-origin CSRF checks; proxy trust must be configured deliberately.
- The production container runs without root privileges on a read-only filesystem. PostgreSQL and the kernel remain inside the Compose network behind the Caddy TLS edge.

The [PRD threat model](prd.md#18-security-privacy-and-operational-boundaries) documents permissions and residual risks.

## Report a vulnerability

Use [GitHub's private vulnerability reporting](https://github.com/Vasanthdev2004/moneykernel/security/advisories/new). Include the affected commit, reproduction steps, expected and observed behavior, and a sanitized impact example. Do not send real account credentials, operator secrets, agent tokens, or customer data. Do not open a public issue containing an exploitable vulnerability before coordination with the maintainer.

Reports affecting authority escalation, cross-account access, duplicate submission, inconsistent reservations, accounting, credential disclosure, or unsafe recovery receive priority. Response times are not guaranteed for this independently maintained hackathon project.

An internally consistent audit chain does not prove that an upstream data source is truthful or reveal a complete history rewrite without an independently retained checkpoint. Public market data can be unavailable or stale, and paper execution does not establish external venue behavior.
