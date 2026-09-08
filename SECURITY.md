# Security

MoneyKernel v0.1 supports a production-hardened private SHADOW beta. It is not a licensed financial service or custody solution, and it cannot place a real-money order.

## Boundaries

- Safety authority is deterministic application code. No model output can change policy, grant approval, mint leases, or arm an order.
- Default mode is REPLAY (offline fixtures, virtual funds). SHADOW uses real market observations with virtual funds. TESTNET uses Binance Spot Testnet only after qualification. There is no mainnet execution path and no configuration option to create one.
- The strategy process never receives exchange credentials, operator session data, or a writable database connection.
- Secrets live only in `.env` (gitignored) or environment injection. Nothing in this repository grants access to any account.
- Production config requires an HTTPS canonical origin, strong and separate operator/metrics secrets, a trusted-proxy declaration, and a bounded global request rate. Browser mutations require same-origin CSRF; metrics use a separate bearer token.
- The production container runs as a non-root user with a read-only root filesystem. PostgreSQL and the kernel are reachable only through the Compose network; Caddy is the public TLS edge.

See `prd.md` section 18 for the threat model, role permissions, and residual limitations, and `docs/production-shadow.md` for deployment controls and response procedures.

## Reporting

Open a private security advisory on the GitHub repository, or contact the maintainer directly. Do not open public issues for credential or authorization problems.
