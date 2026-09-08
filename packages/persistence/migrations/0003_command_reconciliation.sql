-- Acceptance alone does not prove that fills, fees, and reservations settled.
-- Existing accepted commands remain blocked until a reconciler verifies them.
ALTER TABLE commands ADD COLUMN reconciled_at TIMESTAMPTZ;
ALTER TABLE commands ADD CONSTRAINT commands_reconciliation_after_arm
  CHECK (reconciled_at IS NULL OR
         (state = 'ACCEPTED' AND armed_at IS NOT NULL AND reconciled_at >= armed_at));

COMMENT ON COLUMN commands.reconciled_at IS
  'Set only in the terminal reconciliation transaction after fills, fees, balances and reservations agree. Never inferred from an accepted or terminal order response alone.';
