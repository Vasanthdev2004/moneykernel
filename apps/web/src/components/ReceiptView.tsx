import type { ReactNode } from "react";
import { fmtAge, shortHash, shortId, trimDecimal } from "../format.ts";
import { commandState, decisionOutcome, proposalState, reservationState, ruleResult } from "../states.ts";
import type { Agent, IntentDocument, Receipt } from "../types.ts";
import { Badge, DefList, Empty, ErrorNote, JsonBlock, Mono, Panel, StateBadge, Timestamp } from "./common.tsx";

export interface Selection {
  kind: "proposal" | "intent";
  id: string;
}

function ReceiptBlock({ receipt, serverNow, open }: { receipt: Receipt; serverNow: number; open: boolean }) {
  const outcome = decisionOutcome(receipt.outcome);
  const versions: Array<[string, ReactNode]> = [
    ["Policy version", <Mono>{receipt.input_refs.policy_version}</Mono>],
    ["Lease revision", <Mono>{receipt.input_refs.lease_revision}</Mono>],
    ["Account epoch", <Mono>{receipt.input_refs.account_epoch}</Mono>],
    ["Ledger version", <Mono>{receipt.input_refs.ledger_version}</Mono>],
    [
      "Snapshots",
      receipt.input_refs.snapshot_ids.length === 0 ? (
        "none"
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
    <details className="details receipt" open={open}>
      <summary>
        <StateBadge presentation={outcome} />{" "}
        <Mono className="muted small" title={receipt.id}>
          {shortId(receipt.id)}
        </Mono>{" "}
        <span className="muted small">
          <Timestamp iso={receipt.evaluated_at} />
        </span>
      </summary>
      {receipt.reasons.length > 0 && (
        <p>
          Reasons:{" "}
          {receipt.reasons.map((code) => (
            <Mono key={code} className="reason-code">
              {code}
            </Mono>
          ))}
        </p>
      )}
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
      <DefList items={versions} />
      <details className="details">
        <summary>Normalized request</summary>
        <JsonBlock value={receipt.normalized_request} />
      </details>
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
  const command = doc?.command ?? null;
  const commandPresentation = command ? commandState(command.state) : null;
  return (
    <Panel
      id="receipt"
      title="Receipt"
      subtitle={
        selection === null ? "no selection" : `${selection.kind} ${shortId(selection.id)}${loading ? " · loading" : ""}`
      }
      actions={
        <button
          type="button"
          className="btn btn-small"
          data-testid="export-receipt"
          onClick={onExport}
          disabled={doc === null}
        >
          Export receipt JSON
        </button>
      }
    >
      <ErrorNote message={error} prefix="receipt" />
      {selection === null && (
        <Empty>Select a proposal in the queue or an event on the timeline to see its receipt and linkage.</Empty>
      )}
      {selection !== null && doc === null && !loading && error === null && <Empty>No document.</Empty>}
      {doc !== null && (
        <>
          <h4>Intent</h4>
          <DefList
            items={[
              ["Intent", <Mono title={doc.intent.id}>{doc.intent.id}</Mono>],
              [
                "Agent",
                <>
                  {agentsById.get(doc.intent.agent_id)?.name ?? "unknown"} ·{" "}
                  <Mono title={doc.intent.agent_id}>{shortId(doc.intent.agent_id)}</Mono>
                </>,
              ],
              ["Lease", <Mono title={doc.intent.lease_id}>{shortId(doc.intent.lease_id)}</Mono>],
              [
                "Received",
                <>
                  <Timestamp iso={doc.intent.created_at} /> · seq <Mono>{doc.intent.account_seq}</Mono>
                </>,
              ],
              ["Payload hash", <Mono title={doc.intent.payload_hash}>{shortHash(doc.intent.payload_hash, 16)}</Mono>],
              ["Idempotency key", <Mono>{doc.intent.idempotency_key}</Mono>],
            ]}
          />
          <details className="details">
            <summary>Canonical payload</summary>
            <JsonBlock value={doc.intent.canonical_payload} />
          </details>

          <h4>Receipts ({doc.receipts.length})</h4>
          {doc.receipts.length === 0 ? (
            <p className="muted small">No receipt recorded yet.</p>
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

          <h4>Proposals ({doc.proposals.length})</h4>
          {doc.proposals.length === 0 ? (
            <p className="muted small">No proposal was created (denied or held before proposal).</p>
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

          <h4>Linkage</h4>
          <ol className="linkage">
            <li>
              <span className="label">Command</span>{" "}
              {command === null || commandPresentation === null ? (
                <span className="muted small">none (nothing was armed)</span>
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
                <span className="muted small">none observed</span>
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
                <span className="muted small">none reconciled (an accepted order is not a fill)</span>
              ) : (
                <ul className="plain">
                  {doc.fills.map((fill) => (
                    <li key={fill.id}>
                      <Badge tone="green" glyph="✓">
                        reconciled fill
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
                <span className="muted small">none</span>
              ) : (
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
              )}
            </li>
          </ol>
        </>
      )}
    </Panel>
  );
}
