import { canonicalJson, hashCanonical, type RunExport } from "@moneykernel/contracts";
import { dec, eq } from "@moneykernel/domain";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Row) : null;
function same(a: unknown, b: unknown): boolean {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
}
function amount(a: unknown, b: unknown): boolean {
  try {
    return typeof a === "string" && typeof b === "string" && eq(dec(a), dec(b));
  } catch {
    return false;
  }
}

/** Bind the immutable row identities/material to the account audit trail in both directions. */
export function auditLinkageProblems(run: RunExport): string[] {
  const problems: string[] = [];
  const families: Record<string, Row[]> = {
    policy: run.policy_versions,
    agent: run.agents,
    lease: run.leases,
    intent: run.intents,
    proposal: run.proposals,
    approval: run.approvals,
    command: run.commands,
    order: run.orders,
    fill: run.fills,
    reservation: run.reservations,
    ledger: run.ledger_entries,
    conflict: run.conflicts,
    incident: run.incidents,
    receipt: run.receipts.map((receipt) => ({ ...receipt, id: receipt.decision_id })),
  };
  const maps = new Map<string, Map<string, Row>>();
  for (const [kind, rows] of Object.entries(families)) {
    const indexed = new Map<string, Row>();
    for (const item of rows) {
      if (typeof item.id !== "string" || item.id.length === 0) problems.push(`${kind}: missing row id`);
      else if (indexed.has(item.id)) problems.push(`${kind}: duplicate row id`);
      else indexed.set(item.id, item);
      if (item.account_id !== undefined && item.account_id !== run.account.id)
        problems.push(`${kind}: foreign account`);
    }
    maps.set(kind, indexed);
  }
  const get = (kind: string, id: unknown) => (typeof id === "string" ? maps.get(kind)?.get(id) : undefined);
  const requireRef = (kind: string, id: unknown, from: string) => {
    const found = get(kind, id);
    if (found === undefined) problems.push(`${from}: missing ${kind}`);
    return found;
  };
  const unique = (rows: Row[], fields: string[], kind: string) => {
    const seen = new Set<string>();
    for (const item of rows) {
      const values = fields.map((key) => item[key]);
      if (values.some((value) => typeof value !== "string" || value.length === 0)) {
        problems.push(`${kind}: missing unique identity`);
        continue;
      }
      const key = JSON.stringify(values);
      if (seen.has(key)) problems.push(`${kind}: duplicate unique identity`);
      seen.add(key);
    }
  };
  for (const key of ["client_order_id", "approval_id", "proposal_id"]) unique(run.commands, [key], "command");
  unique(run.orders, ["command_id"], "order");
  unique(run.balances, ["asset"], "balance");
  unique(run.allocations, ["asset", "agent_or_unassigned_id"], "allocation");
  for (const lease of run.leases) requireRef("agent", lease.agent_id, "lease");
  for (const intent of run.intents) {
    requireRef("agent", intent.agent_id, "intent");
    const lease = requireRef("lease", intent.lease_id, "intent");
    if (lease !== undefined && lease.agent_id !== intent.agent_id)
      problems.push("intent: lease belongs to another agent");
    try {
      if (hashCanonical(intent.canonical_payload) !== intent.payload_hash)
        problems.push("intent: payload hash differs");
    } catch {
      problems.push("intent: invalid canonical payload");
    }
    if (!run.receipts.some((receipt) => receipt.intent_id === intent.id)) problems.push("intent: receipt missing");
  }
  for (const proposal of run.proposals) {
    requireRef("policy", proposal.policy_id, "proposal");
    if (!run.receipts.some((receipt) => receipt.proposal_id === proposal.id))
      problems.push("proposal: receipt missing");
  }
  for (const hold of run.reservations) requireRef("agent", hold.agent_id, "reservation");
  for (const entry of run.ledger_entries) if (entry.agent_id !== null) requireRef("agent", entry.agent_id, "ledger");
  for (const allocation of run.allocations) {
    if (allocation.agent_or_unassigned_id !== "UNASSIGNED")
      requireRef("agent", allocation.agent_or_unassigned_id, "allocation");
  }
  for (const receipt of run.receipts) {
    const intent = get("intent", receipt.intent_id);
    const proposal = receipt.proposal_id === null ? undefined : get("proposal", receipt.proposal_id);
    if (proposal !== undefined && proposal.intent_id !== receipt.intent_id)
      problems.push("receipt: proposal belongs to another intent");
    const request = receipt.normalized_request;
    if (
      request.account_id !== run.account.id ||
      request.agent_id !== intent?.agent_id ||
      request.lease_id !== intent?.lease_id
    ) {
      problems.push("receipt: authenticated request identity differs from intent/account");
    }
    const payload = row(intent?.canonical_payload);
    if (payload !== null) {
      const { schema_version: _version, rationale: _rationale, ...material } = payload;
      if (
        !same(request, {
          ...material,
          strategy_run_id: material.strategy_run_id ?? null,
          account_id: run.account.id,
          agent_id: intent?.agent_id,
        })
      )
        problems.push("receipt: request differs from original intent");
    }
    const context = row(receipt.evaluation_input);
    if (context !== null && !same(context.intent, intent?.canonical_payload))
      problems.push("receipt: archived intent differs");
    const policy = run.policy_versions.find((item) => item.version === receipt.input_refs.policy_version);
    const storedPolicy = row(policy?.policy);
    if (storedPolicy === null) problems.push("receipt: policy version missing");
    else {
      try {
        if (hashCanonical(storedPolicy) !== policy?.hash) problems.push("policy: stored hash differs");
      } catch {
        problems.push("policy: invalid canonical material");
      }
      if (context !== null && !same(context.policy, { ...storedPolicy, version: policy?.version })) {
        problems.push("receipt: archived policy differs from versioned policy");
      }
    }
  }

  // Run exports carry complete account history. A chain slice alone cannot establish row completeness.
  if (run.checkpoint.previous_hash !== null)
    problems.push("account history is a slice; full row coverage is unverifiable");
  const creation = run.audit_events.filter((event) => event.type === "ACCOUNT_CREATED");
  if (
    creation.length !== 1 ||
    (creation[0]?.payload.account_id !== undefined && creation[0].payload.account_id !== run.account.id) ||
    creation[0]?.payload.environment !== run.environment
  )
    problems.push("account creation evidence missing or inconsistent");
  const covered = new Map<string, Set<unknown>>();
  const bind = (kind: string, id: unknown, payload: Row, fields: string[] = [], decimals: string[] = []) => {
    const target = requireRef(kind, id, "audit event");
    if (target === undefined) return;
    const ids = covered.get(kind) ?? new Set();
    ids.add(id);
    covered.set(kind, ids);
    for (const field of fields) {
      if (Object.hasOwn(payload, field) && !same(payload[field], target[field]))
        problems.push(`audit ${kind}: ${field} differs`);
    }
    for (const field of decimals) {
      if (Object.hasOwn(payload, field) && !amount(payload[field], target[field]))
        problems.push(`audit ${kind}: ${field} differs`);
    }
  };
  for (const event of run.audit_events) {
    const p = event.payload;
    switch (event.type) {
      case "POLICY_UPDATED":
        bind("policy", p.policy_id, p, ["version", "hash", "created_by"]);
        break;
      case "AGENT_REGISTERED":
        bind("agent", p.agent_id, p, ["name", "strategy_kind"]);
        break;
      case "LEASE_ISSUED":
        bind("lease", p.lease_id, p, ["agent_id", "attempt_limit"], ["budget_quote"]);
        break;
      case "INTENT_RECEIVED":
        bind("intent", p.intent_id, p, ["agent_id", "lease_id", "payload_hash"]);
        break;
      case "DECISION_RECORDED": {
        bind("receipt", p.receipt_id, p, [
          "intent_id",
          "proposal_id",
          "outcome",
          "reason_codes",
          "decision_fingerprint",
        ]);
        const receipt = get("receipt", p.receipt_id);
        if (receipt !== undefined && Date.parse(event.occurred_at) !== Date.parse(String(receipt.evaluated_at))) {
          problems.push("audit receipt: evaluation time differs");
        }
        break;
      }
      case "RESERVATION_CREATED":
        bind("proposal", p.proposal_id, p, ["revision"]);
        break;
      case "APPROVAL_CREATED":
        bind("approval", p.approval_id, p, [
          "proposal_id",
          "proposal_revision",
          "proposal_hash",
          "operator_id",
          "account_epoch",
        ]);
        break;
      case "COMMAND_CREATED":
      case "COMMAND_ARMED":
      case "COMMAND_OUTCOME":
        bind("command", p.command_id, p, ["proposal_id", "approval_id", "client_order_id"]);
        if (p.exact_payload !== undefined) {
          const command = get("command", p.command_id);
          const adapter = row(p.exact_payload);
          const exact = row(command?.exact_payload);
          if (adapter === null || exact === null) problems.push("audit command: invalid exact_payload");
          else {
            for (const field of [
              "environment",
              "account_id",
              "client_order_id",
              "symbol",
              "side",
              "order_type",
              "quantity",
              "limit_price",
            ]) {
              if (!same(adapter[field], exact[field])) problems.push(`audit command: exact_payload.${field} differs`);
            }
            // COMMAND_ARMED records the adapter OrderCommand, not the database approval payload.
            if (
              adapter.payload_hash !== exact.proposal_hash ||
              adapter.command_id !== command?.id ||
              Date.parse(String(adapter.armed_at)) !== Date.parse(String(command?.armed_at))
            ) {
              problems.push("audit command: dispatch identity/hash/time differs");
            }
          }
        }
        if (p.order_id !== undefined) bind("order", p.order_id, p, ["command_id"]);
        break;
      case "ORDER_OBSERVED":
        bind("order", p.order_id, p, ["command_id", "client_order_id", "exchange_order_id"]);
        break;
      case "FILL_RECONCILED":
        bind(
          "fill",
          p.fill_id,
          p,
          ["order_id", "symbol", "commission_asset"],
          ["base_qty", "price", "quote_qty", "commission_qty"],
        );
        bind("order", p.order_id, p, ["command_id"]);
        break;
      case "CONFLICT_CREATED":
        bind("conflict", p.conflict_id, p, ["symbol"]);
        break;
      case "INCIDENT_RAISED":
        if (p.incident_id !== undefined) bind("incident", p.incident_id, p, ["type", "severity"]);
        break;
    }
  }
  for (const kind of [
    "policy",
    "agent",
    "lease",
    "intent",
    "receipt",
    "proposal",
    "approval",
    "command",
    "order",
    "fill",
    "conflict",
  ]) {
    for (const id of maps.get(kind)?.keys() ?? []) {
      if (!covered.get(kind)?.has(id)) problems.push(`${kind}: audit evidence missing`);
    }
  }
  return problems;
}
