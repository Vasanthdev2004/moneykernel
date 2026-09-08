-- A committed claim prevents retries from repeating control actions after a crash.
-- PENDING is deliberately unresolved: it must never be retried automatically.
CREATE TABLE operator_requests (
  account_id      TEXT NOT NULL REFERENCES accounts (id),
  operator_id     TEXT NOT NULL,
  scope           TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state           TEXT NOT NULL CHECK (state IN ('PENDING', 'COMPLETED')),
  response_status INTEGER,
  response_body   JSONB,
  created_at      TIMESTAMPTZ NOT NULL,
  completed_at    TIMESTAMPTZ,
  PRIMARY KEY (account_id, operator_id, scope, idempotency_key),
  CHECK (
    (state = 'PENDING' AND response_status IS NULL AND response_body IS NULL AND completed_at IS NULL)
    OR (state = 'COMPLETED' AND response_status BETWEEN 200 AND 599
        AND response_body IS NOT NULL AND completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE operator_requests IS
  'Durable payload-bound operator request claims and results. An unresolved PENDING claim requires inspection; never automatically rerun its action.';
