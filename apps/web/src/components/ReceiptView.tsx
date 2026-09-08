import type { ReactNode } from "react";
import { fmtAge, humanizeCode, isRecord, shortHash, shortId, trimDecimal } from "../format.ts";
import { commandState, decisionOutcome, proposalState, reservationState, ruleResult } from "../states.ts";
import type { Agent, IntentDocument, ProposalDetail, Receipt, RuleCheck } from "../types.ts";
import { Badge, DefList, Empty, ErrorNote, JsonBlock, Mono, Panel, StateBadge, Timestamp } from "./common.tsx";

export interface Selection {
  kind: "proposal" | "intent";
  id: string;
}

const RULE_LABELS: Record<string, string> = {
  ACCOUNT_STATUS: "Account availability",
  EXECUTION_RECONCILIATION: "Unresolved orders",
  AGENT_STATUS: "Agent access",
  LEASE_IDENTITY: "Spending lease",
  LEASE_STATUS: "Lease status",
  LEASE_WINDOW: "Lease validity",
  ORDER_TYPE: "Order type",
  SYMBOL_ALLOWED: "Allowed market",
  SIDE_ALLOWED: "Allowed direction",
  SYMBOL_RULES: "Market rules",
  FILTER_SUPPORT: "Exchange filters",
  FEE_MODEL: "Fee currency",
  OBSERVATION_FRESHNESS: "Market data freshness",
  SUBMISSION_LIMIT: "Submission allowance",
  PRICE_TICK: "Price increment",
  VALUATION: "Portfolio valuation",
  LEASE_BUDGET: "Agent spending limit",
  ORDER_NOTIONAL_CAP: "Maximum order size",
  QUOTE_AVAILABILITY: "Available cash",
  SYMBOL_EXPOSURE_LIMIT: "Portfolio concentration",
  BASE_INVENTORY: "Available holdings",
  LOT_SIZE: "Quantity increment",
  MIN_NOTIONAL: "Minimum order value",
};

const REASON_EXPLANATIONS: Record<string, string> = {
  SYMBOL_EXPOSURE_LIMIT: "The original size would concentrate too much value in one market.",
  ORDER_NOTIONAL_CAP: "The original request exceeded the maximum value allowed for one order.",
  LEASE_BUDGET: "The original request exceeded this agent's spending authority.",
  QUOTE_AVAILABILITY: "There was not enough unreserved cash for the original request.",
  INSUFFICIENT_QUOTE: "There was not enough unreserved cash for the request.",
  INSUFFICIENT_BASE: "There were not enough available holdings to sell the requested amount.",
  SUBMISSION_LIMIT: "The agent had no submission attempts remaining.",
  STALE_MARKET_DATA: "The market observation was too old to support a safe decision.",
  OBSERVATION_FRESHNESS: "The market observation was too old to support a safe decision.",
  FILTER_UNSUPPORTED: "The exchange rules needed to validate this order were unavailable.",
  SYMBOL_NOT_ALLOWED: "This market is outside the agent's allowed scope.",
  SIDE_NOT_ALLOWED: "This trade direction is outside the agent's allowed scope.",
  LEASE_EXPIRED: "The agent's spending authority had expired.",
  OUTCOME_UNKNOWN: "An earlier order still has an unknown outcome.",
};

function textValue(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? humanizeCode(rule);
}

function reasonExplanation(code: string): string {
  return REASON_EXPLANATIONS[code] ?? `${humanizeCode(code)} affected this decision.`;
}

function decisionTitle(outcome: string): string {
  switch (outcome) {
    case "ALLOW_PROPOSAL":
      return "Request passed policy";
    case "COUNTERPROPOSE":
      return "Request adjusted to fit policy";
    case "DENY":
      return "Request blocked";
    case "HOLD":
      return "Request held for review";
    default:
      return humanizeCode(outcome);
  }
}

function decisionExplanation(receipt: Receipt): string {
  const reason = receipt.reasons[0] ? reasonExplanation(receipt.reasons[0]) : null;
  switch (receipt.outcome) {
    case "ALLOW_PROPOSAL":
      return "The request stayed within every enforced limit. It can move to exact operator approval.";
    case "COUNTERPROPOSE":
      return `${reason ?? "The original request exceeded a policy limit."} MoneyKernel created a smaller or adjusted candidate for operator review.`;
    case "DENY":
      return reason ?? "The request could not be made safe within the current policy.";
    case "HOLD":
      return `${reason ?? "The request needs more information."} No order can be sent while it is held.`;
    default:
      return "MoneyKernel recorded a deterministic policy decision.";
  }
}

function checkValue(value: string | null, unit: string | null): string {
  if (value === null) return "Not applicable";
  if (unit === "RATIO") {
    const ratio = Number(value);
    if (Number.isFinite(ratio)) return `${trimDecimal(String(ratio * 100))}%`;
  }
  return unit ? `${trimDecimal(value)} ${unit.toLowerCase() === "commands" ? "orders" : unit}` : trimDecimal(value);
}

function checkDescription(check: RuleCheck): string {
  if (check.observed !== null && check.limit !== null) {
    return `Observed ${checkValue(check.observed, check.unit)} · policy limit ${checkValue(check.limit, check.unit)}`;
  }
  if (check.observed !== null) return `Observed ${checkValue(check.observed, check.unit)}`;
  return "This check affected the decision.";
}

function ReceiptBlock({ receipt, serverNow, open }: { receipt: Receipt; serverNow: number; open: boolean }) {
  const outcome = decisionOutcome(receipt.outcome);
  const importantChecks = receipt.checks.filter((check) => check.result === "FAIL" || check.result === "LIMITING");
  const passCount = receipt.checks.filter((check) => check.result === "PASS").length;
  const versions: Array<[string, ReactNode]> = [
    ["Policy version", <Mono>{receipt.input_refs.policy_version}</Mono>],
    ["Lease revision", <Mono>{receipt.input_refs.lease_revision}</Mono>],
    ["Account epoch", <Mono>{receipt.input_refs.account_epoch}</Mono>],
    ["Ledger version", <Mono>{receipt.input_refs.ledger_version}</Mono>],
    [
      "Snapshots",
      receipt.input_refs.snapshot_ids.length === 0 ? (
        "None"
      ) : (
        <ul className="plain">
          {receipt.input_refs.snapshot_ids.map((id, index) => (
            <li key={id}>
              <Mono title={receipt.input_refs.snapshot_hashes[index]}>
                {shortId(id)} · {shortHash(receipt.input_refs.snapshot_hashes[index], 10)}
              </Mono>
            </li>
          ))}
        </ul>
      ),
    ],
    [
      "Decision fingerprint",
      <Mono title={receipt.decision_fingerprint}>{shortHash(receipt.decision_fingerprint, 16)}</Mono>,
    ],
    ["Engine version", <Mono>{receipt.engine_version}</Mono>],
    [
      "Evaluated at",
      <>
        <Timestamp iso={receipt.evaluated_at} /> · <Mono>{fmtAge(receipt.evaluated_at, serverNow)}</Mono>
      </>,
    ],
  ];

  return (
    <details className="receipt-card" open={open}>
      <summary>
        <span>
          <strong>{decisionTitle(receipt.outcome)}</strong>
          <span className="muted small">
            <Timestamp iso={receipt.evaluated_at} />
          </span>
        </span>
        <StateBadge presentation={outcome} />
      </summary>
      <div className="receipt-card-body">
        <section className="decision-explanation" aria-label="Decision explanation">
          <span className="eyebrow">Why this decision</span>
          <p>{decisionExplanation(receipt)}</p>
          {importantChecks.length > 0 && (
            <ul className="decision-highlights">
              {importantChecks.map((check) => {
                const result = ruleResult(check.result);
                return (
                  <li key={`${check.rule}:${check.result}`}>
                    <div>
                      <strong>{ruleLabel(check.rule)}</strong>
                      <span>{checkDescription(check)}</span>
                    </div>
                    <Badge tone={result.tone} glyph={result.glyph}>
                      {check.result === "LIMITING" ? "Adjusted" : result.label}
                    </Badge>
                  </li>
                );
              })}
            </ul>
          )}
          <p className="check-summary">
            {passCount} policy checks passed
            {importantChecks.length > 0 ? ` · ${importantChecks.length} changed the outcome` : ""}
          </p>
        </section>

        <details className="details technical-evidence">
          <summary>Technical evidence · {receipt.checks.length} checks, versions and hashes</summary>
          {receipt.reasons.length > 0 && (
            <p className="muted small">
              Reason codes:{" "}
              {receipt.reasons.map((code) => (
                <Mono key={code} className="reason-code">
                  {code}
                </Mono>
              ))}
            </p>
          )}
          <div className="table-scroll">
            <table className="table checks">
              <caption className="sr-only">Ordered rule checks</caption>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Rule</th>
                  <th>Result</th>
                  <th>Observed</th>
                  <th>Limit</th>
                  <th>Unit</th>
                </tr>
              </thead>
              <tbody>
                {receipt.checks.map((check, index) => {
                  const result = ruleResult(check.result);
                  return (
                    <tr
                      key={`${check.rule}:${check.result}:${check.observed ?? ""}:${check.limit ?? ""}`}
                      className={`check-${check.result.toLowerCase()}`}
                    >
                      <td>
                        <Mono>{index + 1}</Mono>
                      </td>
                      <td>
                        <Mono>{check.rule}</Mono>
                      </td>
                      <td>
                        <Badge tone={result.tone} glyph={result.glyph}>
                          {result.label}
                        </Badge>
                      </td>
                      <td>
                        <Mono className="data">{check.observed ?? "–"}</Mono>
                      </td>
                      <td>
                        <Mono className="data">{check.limit ?? "–"}</Mono>
                      </td>
                      <td>
                        <Mono>{check.unit ?? ""}</Mono>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <DefList items={versions} />
          <details className="details">
            <summary>Normalized request JSON</summary>
            <JsonBlock value={receipt.normalized_request} />
          </details>
        </details>
      </div>
    </details>
  );
}

function requestFacts(doc: IntentDocument, latestProposal: ProposalDetail | undefined): Array<[string, ReactNode]> {
  const request = isRecord(doc.intent.canonical_payload) ? doc.intent.canonical_payload : {};
  const size = isRecord(request.size) ? request.size : {};
  const symbol = textValue(request, "symbol") ?? "Unknown market";
  const quoteAsset = textValue(size, "quote_asset") ?? "quote";
  const baseAsset =
    textValue(size, "base_asset") ?? (symbol.endsWith(quoteAsset) ? symbol.slice(0, -quoteAsset.length) : "base");
  const sizeAsset = textValue(size, "kind") === "BASE_QUANTITY" ? baseAsset : quoteAsset;
  const sizeAmount = textValue(size, "amount");
  const normalizedOrder =
    latestProposal && isRecord(latestProposal.normalized_order) ? latestProposal.normalized_order : null;
  const candidateNotional = normalizedOrder ? textValue(normalizedOrder, "notional_quote") : null;
  const candidateQuantity = normalizedOrder ? textValue(normalizedOrder, "quantity") : null;
  const candidate =
    candidateNotional || candidateQuantity
      ? [
          candidateNotional ? `${trimDecimal(candidateNotional)} ${quoteAsset}` : null,
          candidateQuantity ? `${trimDecimal(candidateQuantity)} ${baseAsset}` : null,
        ]
          .filter(Boolean)
          .join(" · ")
      : null;

  return [
    ["Requested", sizeAmount ? `${trimDecimal(sizeAmount)} ${sizeAsset}` : "Not provided"],
    [
      "Limit price",
      textValue(request, "limit_price")
        ? `${trimDecimal(textValue(request, "limit_price"))} ${quoteAsset}`
        : "Not provided",
    ],
    ...(candidate ? ([["Policy candidate", candidate]] as Array<[string, ReactNode]>) : []),
    [
      "Order behavior",
      textValue(request, "order_type") === "LIMIT_IOC"
        ? "Limit · immediate or cancel"
        : humanizeCode(textValue(request, "order_type") ?? "unknown"),
    ],
  ];
}

function RequestOverview({
  doc,
  agentsById,
  serverNow,
}: {
  doc: IntentDocument;
  agentsById: Map<string, Agent>;
  serverNow: number;
}) {
  const request = isRecord(doc.intent.canonical_payload) ? doc.intent.canonical_payload : {};
  const symbol = textValue(request, "symbol") ?? "a market";
  const side = textValue(request, "side")?.toLowerCase() ?? "trade";
  const agentName = agentsById.get(doc.intent.agent_id)?.name ?? "An agent";
  const latestReceipt = doc.receipts.at(-1);
  const latestProposal = doc.proposals.at(-1);
  const commandPresentation = doc.command ? commandState(doc.command.state) : null;
  const proposalPresentation = latestProposal ? proposalState(latestProposal.state) : null;
  return (
    <>
      <section className="request-overview">
        <span className="eyebrow">Agent request</span>
        <h3>
          {agentName} asked to {side} {symbol}
        </h3>
        <DefList className="request-facts" items={requestFacts(doc, latestProposal)} />
        <p className="muted small">
          Received <Timestamp iso={doc.intent.created_at} /> · {fmtAge(doc.intent.created_at, serverNow)}
        </p>
      </section>
      <section className="receipt-progress" aria-label="Request progress">
        <div>
          <span>Request</span>
          <Badge tone="neutral" glyph="✓">
            Received
          </Badge>
        </div>
        <div>
          <span>Decision</span>
          {latestReceipt ? (
            <StateBadge presentation={decisionOutcome(latestReceipt.outcome)} />
          ) : (
            <Badge tone="muted">Pending</Badge>
          )}
        </div>
        <div>
          <span>Proposal</span>
          {proposalPresentation ? (
            <StateBadge presentation={proposalPresentation} />
          ) : (
            <Badge tone="muted">None created</Badge>
          )}
        </div>
        <div>
          <span>Execution</span>
          {doc.order ? (
            <Badge tone="neutral">{humanizeCode(doc.order.status)}</Badge>
          ) : commandPresentation ? (
            <StateBadge presentation={commandPresentation} />
          ) : (
            <Badge tone="muted">Not sent</Badge>
          )}
        </div>
      </section>
    </>
  );
}

function TechnicalRecords({ doc, agentsById }: { doc: IntentDocument; agentsById: Map<string, Agent> }) {
  const command = doc.command;
  const commandPresentation = command ? commandState(command.state) : null;
  return (
    <details className="details technical-records">
      <summary>Request identifiers and execution records</summary>
      <h4>Request identifiers</h4>
      <DefList
        items={[
          ["Intent", <Mono title={doc.intent.id}>{doc.intent.id}</Mono>],
          [
            "Agent",
            <>
              {agentsById.get(doc.intent.agent_id)?.name ?? "Unknown"} ·{" "}
              <Mono title={doc.intent.agent_id}>{shortId(doc.intent.agent_id)}</Mono>
            </>,
          ],
          ["Lease", <Mono title={doc.intent.lease_id}>{shortId(doc.intent.lease_id)}</Mono>],
          ["Sequence", <Mono>{doc.intent.account_seq}</Mono>],
          ["Payload hash", <Mono title={doc.intent.payload_hash}>{shortHash(doc.intent.payload_hash, 16)}</Mono>],
          ["Idempotency key", <Mono>{doc.intent.idempotency_key}</Mono>],
        ]}
      />
      <details className="details">
        <summary>Canonical request JSON</summary>
        <JsonBlock value={doc.intent.canonical_payload} />
      </details>

      <h4>Proposal records ({doc.proposals.length})</h4>
      {doc.proposals.length === 0 ? (
        <p className="muted small">No proposal was created.</p>
      ) : (
        doc.proposals.map((proposal) => (
          <div className="proposal-detail" key={`${proposal.proposal_id}-${proposal.revision}`}>
            <div className="row-line">
              <StateBadge presentation={proposalState(proposal.state)} />{" "}
              <Mono title={proposal.proposal_id}>
                {shortId(proposal.proposal_id)} r{proposal.revision}
              </Mono>{" "}
              <Mono className="muted small" title={proposal.proposal_hash}>
                hash {shortHash(proposal.proposal_hash)}
              </Mono>
            </div>
            <div className="muted small">
              policy <Mono>{shortId(proposal.policy_id)}</Mono> · lease rev <Mono>{proposal.lease_revision}</Mono> ·
              epoch <Mono>{proposal.account_epoch}</Mono> · expires <Timestamp iso={proposal.expires_at} />
            </div>
            {proposal.reservations.length > 0 && (
              <ul className="plain">
                {proposal.reservations.map((reservation) => {
                  const state = reservationState(reservation.state);
                  return (
                    <li key={reservation.id}>
                      <Badge tone={state.tone} glyph={state.glyph}>
                        {state.label}
                      </Badge>{" "}
                      <Mono className="data">
                        {reservation.kind} {trimDecimal(reservation.amount)} {reservation.asset}
                      </Mono>
                    </li>
                  );
                })}
              </ul>
            )}
            {proposal.approvals.length > 0 && (
              <ul className="plain">
                {proposal.approvals.map((approval) => (
                  <li key={approval.id}>
                    <Badge tone="gold" glyph="◆">
                      approval {approval.status}
                    </Badge>{" "}
                    <Mono className="muted small">
                      {shortId(approval.id)} · by {approval.operator_id} · epoch {approval.account_epoch} ·{" "}
                      {approval.consumed_at ? `consumed ${approval.consumed_at}` : `expires ${approval.expires_at}`}
                    </Mono>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))
      )}

      <h4>Execution linkage</h4>
      <ol className="linkage">
        <li>
          <span className="label">Command</span>{" "}
          {command === null || commandPresentation === null ? (
            <span className="muted small">None · the order was never armed</span>
          ) : (
            <>
              <StateBadge presentation={commandPresentation} showNote />{" "}
              <Mono title={command.id}>{shortId(command.id)}</Mono> · client order{" "}
              <Mono>{command.client_order_id}</Mono>
              <div className="muted small">
                armed <Timestamp iso={command.armed_at} /> · reconciled <Timestamp iso={command.reconciled_at} />
              </div>
              {command.outcome_ref !== null && command.outcome_ref !== undefined && (
                <details className="details">
                  <summary>Outcome reference</summary>
                  <JsonBlock value={command.outcome_ref} />
                </details>
              )}
            </>
          )}
        </li>
        <li>
          <span className="label">Order</span>{" "}
          {doc.order === null ? (
            <span className="muted small">None observed</span>
          ) : (
            <>
              <Badge tone="neutral">{doc.order.status}</Badge> <Mono>{doc.order.symbol}</Mono> · exchange id{" "}
              <Mono>{doc.order.exchange_order_id ?? "–"}</Mono>
              <div className="muted small">
                executed <Mono className="data">{trimDecimal(doc.order.executed_base)}</Mono> base /{" "}
                <Mono className="data">{trimDecimal(doc.order.executed_quote)}</Mono> quote · observed{" "}
                <Timestamp iso={doc.order.last_observed_at} />
              </div>
            </>
          )}
        </li>
        <li>
          <span className="label">Fills ({doc.fills.length})</span>{" "}
          {doc.fills.length === 0 ? (
            <span className="muted small">None reconciled</span>
          ) : (
            <ul className="plain">
              {doc.fills.map((fill) => (
                <li key={fill.id}>
                  <Badge tone="green" glyph="✓">
                    Reconciled fill
                  </Badge>{" "}
                  <Mono className="data">
                    {trimDecimal(fill.base_qty)} @ {trimDecimal(fill.price)} = {trimDecimal(fill.quote_qty)} · fee{" "}
                    {trimDecimal(fill.commission_qty)} {fill.commission_asset}
                  </Mono>{" "}
                  <span className="muted small">
                    trade <Mono>{fill.exchange_trade_id}</Mono> · <Timestamp iso={fill.event_time} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
        <li>
          <span className="label">Ledger entries ({doc.ledger_entries.length})</span>{" "}
          {doc.ledger_entries.length === 0 ? (
            <span className="muted small">None</span>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Seq</th>
                    <th>Asset</th>
                    <th>Delta</th>
                    <th>Category</th>
                    <th>Fill</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.ledger_entries.map((entry) => (
                    <tr key={entry.id}>
                      <td>
                        <Mono>{entry.sequence}</Mono>
                      </td>
                      <td>
                        <Mono>{entry.asset}</Mono>
                      </td>
                      <td>
                        <Mono className="data">{trimDecimal(entry.signed_delta)}</Mono>
                      </td>
                      <td>{entry.category}</td>
                      <td>
                        <Mono className="muted small">
                          {entry.source_fill_id ? shortId(entry.source_fill_id) : "–"}
                        </Mono>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </li>
      </ol>
    </details>
  );
}

export function ReceiptView({
  selection,
  doc,
  loading,
  error,
  serverNow,
  agentsById,
  onExport,
}: {
  selection: Selection | null;
  doc: IntentDocument | null;
  loading: boolean;
  error: string | null;
  serverNow: number;
  agentsById: Map<string, Agent>;
  onExport: () => void;
}) {
  return (
    <Panel
      id="receipt"
      className="receipt-panel"
      title="Decision receipt"
      subtitle={
        selection === null
          ? "Choose an activity item"
          : `${loading ? "Loading · " : ""}${selection.kind === "proposal" ? "Proposal" : "Request"} ${shortId(selection.id)}`
      }
      actions={
        <button
          type="button"
          className="btn btn-small"
          data-testid="export-receipt"
          onClick={onExport}
          disabled={doc === null}
        >
          Export JSON
        </button>
      }
    >
      <ErrorNote message={error} prefix="receipt" />
      {selection === null && <Empty>Choose an activity item to see why MoneyKernel made its decision.</Empty>}
      {selection !== null && doc === null && !loading && error === null && <Empty>No receipt was found.</Empty>}
      {doc !== null && (
        <div className="receipt-content">
          <RequestOverview doc={doc} agentsById={agentsById} serverNow={serverNow} />

          <section className="decision-history" aria-labelledby="decision-history-heading">
            <div className="receipt-section-heading">
              <h3 id="decision-history-heading">Decision</h3>
              {doc.receipts.length > 1 && <span className="muted small">{doc.receipts.length} evaluations</span>}
            </div>
            {doc.receipts.length === 0 ? (
              <p className="muted small">No decision receipt has been recorded yet.</p>
            ) : (
              doc.receipts.map((receipt, index) => (
                <ReceiptBlock
                  key={receipt.id}
                  receipt={receipt}
                  serverNow={serverNow}
                  open={index === doc.receipts.length - 1}
                />
              ))
            )}
          </section>

          <TechnicalRecords doc={doc} agentsById={agentsById} />
        </div>
      )}
    </Panel>
  );
}
