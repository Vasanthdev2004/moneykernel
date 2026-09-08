-- Verification replay runs the pure evaluator with the original archived logical context (prd.md 14.5, T-55).
-- The receipt keeps that context beside its fingerprint material. Existing receipts predate the column and stay
-- verifiable by fingerprint only; a replay tool must report "context not archived" for them, never guess.
ALTER TABLE decision_receipts ADD COLUMN evaluation_input JSONB;

COMMENT ON COLUMN decision_receipts.evaluation_input IS
  'Exact EvaluationInput the pure evaluator saw (plain decimal strings, snapshot ids and hashes). Immutable with the receipt.';
