// Response shapes of the kernel's operator API (prd.md 15.2). The console
// renders these; it never derives financial state on its own.

export type Environment = "REPLAY" | "SHADOW" | "TESTNET";
export type AccountStatus = "PAUSED" | "READY" | "RECONCILING" | "ERROR";
export type IntegrationState = "CONNECTED" | "DEGRADED" | "NOT_CONNECTED" | "NOT_CONFIGURED" | "BLOCKED";
export type IntegrationKey = "agent_os_mcp" | "market_data" | "execution" | "model";
export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT_IOC";
export type AgentStatus = "ACTIVE" | "QUARANTINED" | "DISABLED";
export type StrategyKind = "SCRIPTED" | "MODEL" | "RECORDED" | "SUPPORTED_AGENT";
export type ProposalState =
  | "RECEIVED"
  | "DENIED"
  | "COLLECTING"
  | "CONFLICT_HELD"
  | "AWAITING_APPROVAL"
  | "APPROVED"
  | "INVALIDATED"
  | "REJECTED"
  | "EXPIRED"
  | "COMMAND_CREATED";
export type CommandState =
  | "READY"
  | "ABORTED_PRE_ARM"
  | "ARMED"
  | "ACCEPTED"
  | "REJECTED_CONFIRMED"
  | "OUTCOME_UNKNOWN";
export type DecisionOutcome = "ALLOW_PROPOSAL" | "COUNTERPROPOSE" | "DENY" | "HOLD";
export type RuleResult = "PASS" | "FAIL" | "LIMITING" | "SKIPPED";
export type ReservationKind = "QUOTE" | "BASE" | "ATTEMPT";
export type ReservationState = "HELD" | "ARMED" | "CONSUMED" | "RELEASED";
export type IncidentSeverity = "INFO" | "WARNING" | "CRITICAL";
export type IncidentStatus = "OPEN" | "RESOLVED";

export interface SessionResponse {
  session_token: string;
  csrf_token: string;
  operator_id: string;
  expires_at: string;
  note?: string;
}

export interface HealthLive {
  status: string;
  server_time: string;
}

export interface ErrorEnvelope {
  error: { code: string; message: string; request_id: string; details?: unknown };
}

export interface IntegrationStatus {
  state: IntegrationState;
  detail: string;
  last_successful_read_at: string | null;
}

export interface ReadinessCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface Readiness {
  ready: boolean;
  checks: ReadinessCheck[];
}

export interface Provenance {
  execution_mode: Environment;
  market_source: string;
  model_source: string;
  execution_source: string;
}

export interface AccountSummary {
  id: string;
  alias: string;
  environment: Environment;
  status: AccountStatus;
  epoch: number;
  quote_asset: string;
}

export interface StatusResponse {
  service: string;
  engine_version: string;
  server_time: string;
  mode: Environment;
  account: AccountSummary;
  in_flight_commands: number;
  unresolved_commands: number;
  provenance: Provenance;
  integration: Record<IntegrationKey, IntegrationStatus>;
  readiness: Readiness;
}

export interface Balance {
  asset: string;
  owned_quantity: string;
}

export interface ReservationSummary {
  asset: string;
  kind: ReservationKind;
  state: "HELD" | "ARMED";
  amount: string;
}

export interface OverviewResponse {
  server_time: string;
  account: AccountSummary;
  balances: Balance[];
  reservations: ReservationSummary[];
  available_quote: string;
  cash_buffer_quote: string;
  reserved_quote: string;
  pending_approvals: number;
  open_conflicts: number;
  open_incidents: Record<IncidentSeverity, number>;
  commands: Record<CommandState, number>;
  in_flight_commands: number;
  unresolved_commands: number;
  readiness: Readiness;
}

export interface LeaseCapabilities {
  allowed_symbols: string[];
  allowed_sides: Side[];
  allowed_order_types: OrderType[];
}

export interface ActiveLease extends LeaseCapabilities {
  lease_id: string;
  revision: number;
  acquisition_budget_quote: string;
  consumed_quote: string;
  max_submission_attempts: number;
  attempts_consumed: number;
  starts_at: string;
  expires_at: string;
}

export interface LeaseRecord extends ActiveLease {
  agent_id: string;
  status: string;
}

export interface Holding {
  asset: string;
  quantity: string;
}

export interface Agent {
  id: string;
  name: string;
  strategy_kind: StrategyKind;
  status: AgentStatus;
  revision: number;
  active_lease: ActiveLease | null;
  holdings: Holding[];
}

export interface AgentsResponse {
  agents: Agent[];
}

export interface LeasesResponse {
  leases: LeaseRecord[];
}

export interface PolicyValues {
  max_order_notional_quote: string;
  max_symbol_share: string;
  min_quote_cash_buffer: string;
  valuation_buffer_quote: string;
  max_proposal_age_ms: number;
  max_market_observation_age_ms: number;
  max_account_observation_age_ms: number;
  max_price_drift_bps: string;
  conflict_collection_window_ms: number;
  max_unique_intents_per_60s: number;
  max_hard_violations_per_60s: number;
  fee_rate: string;
  fee_asset: string;
  quote_asset: string;
}

export interface PolicyResponse {
  version: number;
  hash: string;
  created_by: string;
  created_at: string;
  policy: PolicyValues;
}

export type IntentSize =
  | { kind: "QUOTE_NOTIONAL"; quote_asset: string; amount: string }
  | { kind: "BASE_QUANTITY"; base_asset: string; amount: string };

export interface IntentRequest {
  symbol: string;
  side: Side;
  order_type: OrderType;
  size: IntentSize;
  limit_price: string;
  observation_ids?: string[];
  rationale?: string;
  strategy_run_id?: string;
  lease_id?: string;
  schema_version?: string;
}

export interface CandidateOrder {
  symbol: string;
  side: Side;
  order_type: OrderType;
  quantity: string;
  limit_price: string;
  notional_quote: string;
  fee_reserve_quote: string;
  total_quote_reserved: string;
  base_reserved: string;
  reference_mark: string;
}

export interface ProposalListItem {
  proposal_id: string;
  revision: number;
  state: ProposalState;
  agent_id: string;
  lease_id: string;
  requested: IntentRequest;
  candidate: CandidateOrder;
  proposal_hash: string;
  account_epoch: number;
  lease_revision: number;
  policy_id: string;
  created_at: string;
  expires_at: string;
}

export interface ConflictListItem {
  conflict_id: string;
  symbol: string;
  status: string;
  proposal_ids: string[];
  created_at: string;
}

export interface ProposalsResponse {
  proposals: ProposalListItem[];
  conflicts: ConflictListItem[];
  server_time: string;
}

export interface RuleCheck {
  rule: string;
  result: RuleResult;
  observed: string | null;
  limit: string | null;
  unit: string | null;
}

export interface InputRefs {
  policy_version: number;
  lease_revision: number;
  account_epoch: number;
  ledger_version: number;
  snapshot_ids: string[];
  snapshot_hashes: string[];
}

export interface Receipt {
  id: string;
  proposal_id: string | null;
  outcome: DecisionOutcome;
  reasons: string[];
  input_refs: InputRefs;
  checks: RuleCheck[];
  normalized_request: Record<string, unknown>;
  decision_fingerprint: string;
  evaluated_at: string;
  engine_version: string;
}

export interface ReservationRecord {
  id: string;
  asset: string;
  amount: string;
  kind: ReservationKind;
  state: ReservationState;
  created_at: string;
  armed_at: string | null;
  released_at: string | null;
}

export interface ApprovalRecord {
  id: string;
  status: string;
  operator_id: string;
  account_epoch: number;
  proposal_revision: number;
  proposal_hash: string;
  expires_at: string;
  consumed_at: string | null;
  created_at: string;
}

export interface ProposalDetail {
  proposal_id: string;
  revision: number;
  state: ProposalState;
  normalized_order: CandidateOrder | Record<string, unknown> | null;
  proposal_hash: string;
  expires_at: string;
  policy_id: string;
  lease_revision: number;
  account_epoch: number;
  created_at: string;
  updated_at: string;
  reservations: ReservationRecord[];
  approvals: ApprovalRecord[];
}

export interface IntentRecord {
  id: string;
  agent_id: string;
  lease_id: string;
  idempotency_key: string;
  canonical_payload: unknown;
  payload_hash: string;
  account_seq: number;
  created_at: string;
}

export interface CommandRecord {
  id: string;
  proposal_id?: string;
  approval_id?: string;
  state: CommandState;
  client_order_id: string;
  exact_payload: unknown;
  armed_at: string | null;
  reconciled_at: string | null;
  outcome_ref: unknown;
  created_at: string;
  updated_at: string;
}

export interface OrderRecord {
  id: string;
  exchange_order_id: string | null;
  client_order_id: string;
  symbol: string;
  status: string;
  executed_base: string;
  executed_quote: string;
  last_observed_at: string | null;
}

export interface FillRecord {
  id: string;
  exchange_trade_id: string;
  base_qty: string;
  price: string;
  quote_qty: string;
  commission_asset: string;
  commission_qty: string;
  event_time: string;
}

export interface LedgerEntry {
  id: string;
  agent_id?: string | null;
  asset: string;
  signed_delta: string;
  category: string;
  source_fill_id: string | null;
  source_ref?: unknown;
  sequence: number;
  created_at: string;
}

export interface IntentDocument {
  intent: IntentRecord;
  receipts: Receipt[];
  proposals: ProposalDetail[];
  command: CommandRecord | null;
  order: OrderRecord | null;
  fills: FillRecord[];
  ledger_entries: LedgerEntry[];
}

export interface Incident {
  id: string;
  agent_id: string | null;
  type: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  evidence_refs: Record<string, unknown>;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface IncidentsResponse {
  incidents: Incident[];
}

export interface CommandsResponse {
  commands: CommandRecord[];
}

export interface CommandDetail {
  command: CommandRecord;
  order: OrderRecord | null;
  fills: FillRecord[];
  ledger_entries: LedgerEntry[];
  reconciliation_schedule: unknown;
}

export interface Allocation {
  agent_or_unassigned_id: string;
  asset: string;
  owned_quantity: string;
}

export interface LedgerResponse {
  balances: Balance[];
  allocations: Allocation[];
  entries: LedgerEntry[];
  server_time: string;
}

export const AUDIT_EVENT_TYPES = [
  "ACCOUNT_CREATED",
  "ACCOUNT_BOOTED",
  "ACCOUNT_STOPPED",
  "ACCOUNT_RESUMED",
  "ACCOUNT_RECONCILING",
  "ACCOUNT_RECONCILED",
  "POLICY_UPDATED",
  "AGENT_REGISTERED",
  "AGENT_QUARANTINED",
  "AGENT_DISABLED",
  "AGENT_REINSTATED",
  "LEASE_ISSUED",
  "LEASE_REVOKED",
  "LEASE_EXPIRED",
  "LEASE_EXHAUSTED",
  "INVENTORY_ASSIGNED",
  "INTENT_RECEIVED",
  "DECISION_RECORDED",
  "PROPOSAL_STATE_CHANGED",
  "RESERVATION_CREATED",
  "RESERVATION_RELEASED",
  "RESERVATION_CONSUMED",
  "APPROVAL_CREATED",
  "APPROVAL_CONSUMED",
  "APPROVAL_INVALIDATED",
  "CONFLICT_CREATED",
  "CONFLICT_RESOLVED",
  "COMMAND_CREATED",
  "COMMAND_ARMED",
  "COMMAND_OUTCOME",
  "ORDER_OBSERVED",
  "FILL_RECONCILED",
  "INCIDENT_RAISED",
  "INCIDENT_RESOLVED",
  "SNAPSHOT_RECORDED",
] as const;

export interface AuditEvent {
  id: string;
  account_seq: number;
  type: string;
  payload: Record<string, unknown>;
  payload_hash: string;
  previous_hash: string | null;
  event_hash: string;
  occurred_at: string;
}

export interface EventsResponse {
  events: AuditEvent[];
  next_after: number;
  server_time?: string;
}

export interface ApprovalRequest {
  proposal_revision: number;
  proposal_hash: string;
  expected_account_epoch: number;
  operator_confirmation: true;
}

export interface ApprovalResponse {
  approval_id: string;
  proposal_id?: string;
  state: string;
  expires_at: string;
  note?: string;
}

export type ConflictResolution = { action: "SELECT"; proposal_id: string } | { action: "REJECT_BOTH" };

export interface StopResponse {
  status: AccountStatus;
  epoch: number;
  in_flight_commands: unknown[];
  invalidated_proposals: number;
  invalidated_approvals: number;
  note: string;
}

export interface ResumeResponse {
  status: AccountStatus;
  epoch: number;
  checks: ReadinessCheck[];
}

export interface RegisterAgentRequest {
  name: string;
  strategy_kind: StrategyKind;
}

export interface RegisterAgentResponse {
  agent: Agent;
  token: string;
  note: string;
}

export interface IssueLeaseRequest extends LeaseCapabilities {
  agent_id: string;
  acquisition_budget_quote: string;
  max_submission_attempts: number;
  expires_at: string;
}

export interface IssueLeaseResponse {
  lease: LeaseRecord;
}

export interface ReconcileResponse {
  result: string;
  detail: string;
}
