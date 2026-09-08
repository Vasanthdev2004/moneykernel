-- MoneyKernel initial schema (prd.md 14.1, 14.2, 14.3). Sequential migration 0001.
-- Conventions: application-generated TEXT ids, NUMERIC(38,18) for money, TIMESTAMPTZ for time,
-- TEXT + CHECK for state machines (prd.md 11.1), JSONB only for immutable payloads.

CREATE OR REPLACE FUNCTION mk_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (prd.md 14.3); % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mk_forbid_environment_change() RETURNS trigger AS $$
BEGIN
  IF NEW.environment IS DISTINCT FROM OLD.environment THEN
    RAISE EXCEPTION 'account environment is immutable (prd.md 14.2)' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE accounts (
  id                 TEXT PRIMARY KEY,
  environment        TEXT NOT NULL CHECK (environment IN ('REPLAY', 'SHADOW', 'TESTNET')),
  alias              TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('PAUSED', 'READY', 'RECONCILING', 'ERROR')),
  epoch              INTEGER NOT NULL CHECK (epoch >= 0),
  state_version      INTEGER NOT NULL CHECK (state_version >= 0),
  quote_asset        TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL,
  UNIQUE (environment, alias)
);
CREATE TRIGGER accounts_environment_immutable
  BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION mk_forbid_environment_change();

CREATE TABLE agents (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  name          TEXT NOT NULL,
  strategy_kind TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ACTIVE', 'QUARANTINED', 'DISABLED')),
  revision      INTEGER NOT NULL CHECK (revision >= 0),
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX agents_account_idx ON agents (account_id);

CREATE TABLE leases (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  agent_id          TEXT NOT NULL REFERENCES agents (id),
  revision          INTEGER NOT NULL CHECK (revision >= 0),
  budget_quote      NUMERIC(38, 18) NOT NULL CHECK (budget_quote >= 0),
  consumed_quote    NUMERIC(38, 18) NOT NULL DEFAULT 0 CHECK (consumed_quote >= 0),
  attempt_limit     INTEGER NOT NULL CHECK (attempt_limit >= 0),
  attempts_consumed INTEGER NOT NULL DEFAULT 0 CHECK (attempts_consumed >= 0),
  starts_at         TIMESTAMPTZ NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE', 'EXPIRED', 'REVOKED', 'EXHAUSTED')),
  capability_json   JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > starts_at)
);
CREATE UNIQUE INDEX leases_one_active_per_agent ON leases (account_id, agent_id) WHERE status = 'ACTIVE';
CREATE INDEX leases_agent_idx ON leases (agent_id);

CREATE TABLE policy_versions (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts (id),
  version          INTEGER NOT NULL CHECK (version >= 0),
  canonical_policy JSONB NOT NULL,
  hash             TEXT NOT NULL,
  created_by       TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, version)
);
CREATE TRIGGER policy_versions_append_only
  BEFORE UPDATE OR DELETE ON policy_versions FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();

CREATE TABLE snapshots (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  type           TEXT NOT NULL,
  source         TEXT NOT NULL,
  source_time    TIMESTAMPTZ,
  received_at    TIMESTAMPTZ NOT NULL,
  payload        JSONB NOT NULL,
  payload_hash   TEXT NOT NULL,
  parser_version TEXT NOT NULL
);
CREATE INDEX snapshots_source_time_idx ON snapshots (account_id, source, received_at);
CREATE TRIGGER snapshots_append_only
  BEFORE UPDATE OR DELETE ON snapshots FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();

CREATE TABLE asset_balances (
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  asset          TEXT NOT NULL,
  owned_quantity NUMERIC(38, 18) NOT NULL CHECK (owned_quantity >= 0),
  version        INTEGER NOT NULL CHECK (version >= 0),
  PRIMARY KEY (account_id, asset)
);

CREATE TABLE inventory_allocations (
  account_id             TEXT NOT NULL REFERENCES accounts (id),
  agent_or_unassigned_id TEXT NOT NULL,
  asset                  TEXT NOT NULL,
  owned_quantity         NUMERIC(38, 18) NOT NULL CHECK (owned_quantity >= 0),
  version                INTEGER NOT NULL CHECK (version >= 0),
  PRIMARY KEY (account_id, agent_or_unassigned_id, asset)
);

CREATE TABLE intents (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  agent_id          TEXT NOT NULL REFERENCES agents (id),
  lease_id          TEXT NOT NULL REFERENCES leases (id),
  idempotency_key   TEXT NOT NULL,
  canonical_payload JSONB NOT NULL,
  payload_hash      TEXT NOT NULL,
  account_seq       BIGINT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, agent_id, idempotency_key)
);
CREATE TRIGGER intents_append_only
  BEFORE UPDATE OR DELETE ON intents FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();

CREATE TABLE proposals (
  id               TEXT PRIMARY KEY,
  intent_id        TEXT NOT NULL REFERENCES intents (id),
  account_id       TEXT NOT NULL REFERENCES accounts (id),
  revision         INTEGER NOT NULL CHECK (revision >= 0),
  normalized_order JSONB NOT NULL,
  proposal_hash    TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN (
                     'RECEIVED', 'DENIED', 'COLLECTING', 'CONFLICT_HELD', 'AWAITING_APPROVAL',
                     'APPROVED', 'INVALIDATED', 'REJECTED', 'EXPIRED', 'COMMAND_CREATED')),
  expires_at       TIMESTAMPTZ NOT NULL,
  policy_id        TEXT NOT NULL REFERENCES policy_versions (id),
  lease_revision   INTEGER NOT NULL,
  account_epoch    INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL,
  UNIQUE (intent_id, revision)
);
CREATE INDEX proposals_state_expiry_idx ON proposals (state, expires_at);
CREATE INDEX proposals_account_idx ON proposals (account_id, state);

CREATE TABLE decision_receipts (
  id                   TEXT PRIMARY KEY,
  account_id           TEXT NOT NULL REFERENCES accounts (id),
  intent_id            TEXT NOT NULL REFERENCES intents (id),
  proposal_id          TEXT REFERENCES proposals (id),
  outcome              TEXT NOT NULL CHECK (outcome IN ('ALLOW_PROPOSAL', 'COUNTERPROPOSE', 'DENY', 'HOLD')),
  reasons              JSONB NOT NULL,
  input_refs           JSONB NOT NULL,
  checks               JSONB NOT NULL,
  normalized_request   JSONB NOT NULL,
  decision_fingerprint TEXT NOT NULL,
  evaluated_at         TIMESTAMPTZ NOT NULL,
  engine_version       TEXT NOT NULL
);
CREATE INDEX decision_receipts_intent_idx ON decision_receipts (intent_id);
CREATE INDEX decision_receipts_proposal_idx ON decision_receipts (proposal_id);
CREATE TRIGGER decision_receipts_append_only
  BEFORE UPDATE OR DELETE ON decision_receipts FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();

CREATE TABLE reservations (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  proposal_id TEXT NOT NULL REFERENCES proposals (id),
  agent_id    TEXT NOT NULL REFERENCES agents (id),
  asset       TEXT NOT NULL,
  amount      NUMERIC(38, 18) NOT NULL CHECK (amount >= 0),
  kind        TEXT NOT NULL CHECK (kind IN ('QUOTE', 'BASE', 'ATTEMPT')),
  state       TEXT NOT NULL CHECK (state IN ('HELD', 'ARMED', 'CONSUMED', 'RELEASED')),
  created_at  TIMESTAMPTZ NOT NULL,
  armed_at    TIMESTAMPTZ,
  released_at TIMESTAMPTZ
);
CREATE INDEX reservations_account_state_idx ON reservations (account_id, state);
CREATE INDEX reservations_proposal_idx ON reservations (proposal_id);

CREATE TABLE approvals (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  proposal_id       TEXT NOT NULL REFERENCES proposals (id),
  proposal_revision INTEGER NOT NULL,
  proposal_hash     TEXT NOT NULL,
  operator_id       TEXT NOT NULL,
  account_epoch     INTEGER NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('ACTIVE', 'CONSUMED', 'INVALIDATED', 'EXPIRED')),
  consumed_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX approvals_one_active_per_proposal ON approvals (proposal_id) WHERE status = 'ACTIVE';

CREATE TABLE commands (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts (id),
  proposal_id     TEXT NOT NULL UNIQUE REFERENCES proposals (id),
  approval_id     TEXT NOT NULL REFERENCES approvals (id),
  client_order_id TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN (
                    'READY', 'ABORTED_PRE_ARM', 'ARMED', 'ACCEPTED', 'REJECTED_CONFIRMED', 'OUTCOME_UNKNOWN')),
  exact_payload   JSONB NOT NULL,
  armed_at        TIMESTAMPTZ,
  outcome_ref     TEXT,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, client_order_id)
);
CREATE INDEX commands_account_state_idx ON commands (account_id, state);

CREATE TABLE orders (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  command_id        TEXT NOT NULL REFERENCES commands (id),
  exchange_order_id TEXT,
  client_order_id   TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED')),
  executed_base     NUMERIC(38, 18) NOT NULL DEFAULT 0 CHECK (executed_base >= 0),
  executed_quote    NUMERIC(38, 18) NOT NULL DEFAULT 0 CHECK (executed_quote >= 0),
  last_observed_at  TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, client_order_id)
);
CREATE UNIQUE INDEX orders_exchange_order_idx ON orders (account_id, exchange_order_id) WHERE exchange_order_id IS NOT NULL;

CREATE TABLE fills (
  id                TEXT PRIMARY KEY,
  account_id        TEXT NOT NULL REFERENCES accounts (id),
  order_id          TEXT NOT NULL REFERENCES orders (id),
  exchange_trade_id TEXT NOT NULL,
  symbol            TEXT NOT NULL,
  base_qty          NUMERIC(38, 18) NOT NULL CHECK (base_qty >= 0),
  price             NUMERIC(38, 18) NOT NULL CHECK (price >= 0),
  quote_qty         NUMERIC(38, 18) NOT NULL CHECK (quote_qty >= 0),
  commission_asset  TEXT NOT NULL,
  commission_qty    NUMERIC(38, 18) NOT NULL CHECK (commission_qty >= 0),
  event_time        TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, symbol, exchange_trade_id)
);
CREATE TRIGGER fills_append_only
  BEFORE UPDATE OR DELETE ON fills FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();

CREATE TABLE ledger_entries (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts (id),
  agent_id       TEXT REFERENCES agents (id),
  asset          TEXT NOT NULL,
  signed_delta   NUMERIC(38, 18) NOT NULL,
  category       TEXT NOT NULL,
  source_fill_id TEXT REFERENCES fills (id),
  source_ref     TEXT,
  sequence       BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, sequence)
);
CREATE UNIQUE INDEX ledger_entries_fill_application_idx
  ON ledger_entries (source_fill_id, category, asset) WHERE source_fill_id IS NOT NULL;
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();

CREATE TABLE conflicts (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts (id),
  symbol      TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED_SELECTED', 'RESOLVED_REJECTED_BOTH', 'EXPIRED')),
  resolution  JSONB,
  operator_id TEXT,
  created_at  TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ
);
CREATE INDEX conflicts_open_idx ON conflicts (account_id, symbol) WHERE status = 'OPEN';

CREATE TABLE conflict_members (
  conflict_id TEXT NOT NULL REFERENCES conflicts (id),
  proposal_id TEXT NOT NULL REFERENCES proposals (id),
  PRIMARY KEY (conflict_id, proposal_id)
);

CREATE TABLE incidents (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  agent_id      TEXT REFERENCES agents (id),
  type          TEXT NOT NULL,
  severity      TEXT NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'CRITICAL')),
  status        TEXT NOT NULL CHECK (status IN ('OPEN', 'RESOLVED')),
  evidence_refs JSONB NOT NULL,
  resolved_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL,
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX incidents_open_idx ON incidents (account_id) WHERE status = 'OPEN';

CREATE TABLE audit_events (
  id            TEXT PRIMARY KEY,
  account_id    TEXT NOT NULL REFERENCES accounts (id),
  account_seq   BIGINT NOT NULL,
  type          TEXT NOT NULL,
  payload       JSONB NOT NULL,
  payload_hash  TEXT NOT NULL,
  previous_hash TEXT,
  event_hash    TEXT NOT NULL,
  occurred_at   TIMESTAMPTZ NOT NULL,
  UNIQUE (account_id, account_seq)
);
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION mk_forbid_mutation();
