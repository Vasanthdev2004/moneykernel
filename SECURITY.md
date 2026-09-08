# Security

MoneyKernel v0.1 is a hackathon prototype. It is not a licensed financial service, custody solution, or production-ready system.

## Boundaries

- Safety authority is deterministic application code. No model output can change policy, grant approval, mint leases, or arm an order.
- Default mode is REPLAY (offline fixtures, virtual funds). SHADOW uses real market observations with virtual funds. TESTNET uses Binance Spot Testnet only after qualification. There is no mainnet execution path and no configuration option to create one.
- The strategy process never receives exchange credentials, operator session data, or a writable database connection.
- Secrets live only in `.env` (gitignored) or environment injection. Nothing in this repository grants access to any account.

See `prd.md` section 18 for the threat model, role permissions, and residual limitations.

## Reporting

Open a private security advisory on the GitHub repository, or contact the maintainer directly. Do not open public issues for credential or authorization problems.
