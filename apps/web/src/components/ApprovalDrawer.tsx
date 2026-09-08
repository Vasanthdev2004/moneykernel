import { type ReactNode, useState } from "react";
import { amount, describeSize, fmtAge, shortHash, shortId, trimDecimal } from "../format.ts";
import { decisionOutcome, proposalState, reservationState } from "../states.ts";
import type { IntentDocument, ProposalListItem } from "../types.ts";
import { Badge, CountdownText, DefList, ErrorNote, Mono, StateBadge, Timestamp } from "./common.tsx";
import { baseAssetFor, differsFromRequest, quoteAssetFor } from "./DecisionQueue.tsx";

export function ApprovalDrawer({
  proposal,
  doc,
  loading,
  error,
  agentName,
  quoteAsset,
  serverNow,
  policyVersion,
  approveInFlight,
  rejectInFlight,
  onApprove,
  onReject,
  onClose,
}: {
  proposal: ProposalListItem;
  doc: IntentDocument | null;
  loading: boolean;
  error: string | null;
  agentName: string;
  quoteAsset: string | undefined;
  serverNow: number;
  policyVersion: number | null;
  approveInFlight: boolean;
  rejectInFlight: boolean;
  onApprove: (proposal: ProposalListItem) => void;
  onReject: (proposal: ProposalListItem, reason: string | undefined) => void;
  onClose: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");

  const request = proposal.requested;
  const candidate = proposal.candidate;
  const quote = quoteAssetFor(proposal, quoteAsset);
  const base = baseAssetFor(proposal, quote);
  const presentation = proposalState(proposal.state);
  const receipt =
    doc?.receipts.filter((r) => r.proposal_id === proposal.proposal_id).at(-1) ?? doc?.receipts.at(-1) ?? null;
  const detail = doc?.proposals.find((p) => p.proposal_id === proposal.proposal_id) ?? null;
  const limiting = receipt?.checks.filter((check) => check.result === "LIMITING") ?? [];
  const failing = receipt?.checks.filter((check) => check.result === "FAIL") ?? [];
  const expired = Date.parse(proposal.expires_at) <= serverNow;
  const approvable = proposal.state === "AWAITING_APPROVAL" && !expired;
  const rejectable = proposal.state !== "COMMAND_CREATED";
  const differs = differsFromRequest(proposal);

  const diffClass = (a: string, b: string): string => (a === b ? "" : "diff");
  const rows: Array<[string, ReactNode, ReactNode, string]> = [
    ["Symbol", request.symbol, candidate.symbol, diffClass(request.symbol, candidate.symbol)],
    ["Side", request.side, candidate.side, diffClass(request.side, candidate.side)],
    ["Order type", request.order_type, candidate.order_type, diffClass(request.order_type, candidate.order_type)],
    [
      "Size",
      describeSize(request.size),
      `${trimDecimal(candidate.quantity)} ${base} (exact quantity)`,
      request.size.kind === "BASE_QUANTITY" && trimDecimal(request.size.amount) !== trimDecimal(candidate.quantity)
        ? "diff"
        : "",
    ],
    [
      "Limit price",
      trimDecimal(request.limit_price),
      trimDecimal(candidate.limit_price),
      diffClass(trimDecimal(request.limit_price), trimDecimal(candidate.limit_price)),
    ],
    [
      "Notional",
      request.size.kind === "QUOTE_NOTIONAL" ? amount(request.size.amount, quote) : "–",
      amount(candidate.notional_quote, quote),
      request.size.kind === "QUOTE_NOTIONAL" &&
      trimDecimal(request.size.amount) !== trimDecimal(candidate.notional_quote)
        ? "diff"
        : "",
    ],
    ["Fee reserve", "–", amount(candidate.fee_reserve_quote, quote), ""],
    ["Total quote reserved", "–", amount(candidate.total_quote_reserved, quote), ""],
    ["Base reserved", "–", `${trimDecimal(candidate.base_reserved)} ${base}`, ""],
    ["Reference mark", "–", trimDecimal(candidate.reference_mark), ""],
  ];

  const authority: Array<[string, ReactNode]> = [
    [
      "Policy",
      <Mono>
        version {receipt?.input_refs.policy_version ?? policyVersion ?? "?"} · {shortId(proposal.policy_id)}
      </Mono>,
    ],
    ["Lease revision", <Mono>{proposal.lease_revision}</Mono>],
    ["Account epoch", <Mono>{proposal.account_epoch}</Mono>],
    ["Ledger version", <Mono>{receipt?.input_refs.ledger_version ?? "–"}</Mono>],
    [
      "Proposal",
      <Mono title={proposal.proposal_hash}>
        revision {proposal.revision} · hash {shortHash(proposal.proposal_hash)}
      </Mono>,
    ],
  ];

  return (
    <section className="drawer" aria-label={`Approval drawer for proposal ${proposal.proposal_id}`}>
      <header className="drawer-header">
        <div>
          <h3>
            {agentName} ·{" "}
            <Mono>
              {candidate.side} {candidate.symbol}
            </Mono>
          </h3>
          <div className="drawer-meta">
            <StateBadge presentation={presentation} showNote />
            <CountdownText iso={proposal.expires_at} serverNow={serverNow} prefix="expires in " />
            <Mono className="muted small" title={proposal.proposal_id}>
              {shortId(proposal.proposal_id)}
            </Mono>
          </div>
        </div>
        <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Close approval drawer">
          ✕
        </button>
      </header>

      <ErrorNote message={error} prefix="receipt" />
      {loading && doc === null && <p className="muted small">Loading receipt…</p>}

      <table className="table compare">
        <caption className="sr-only">Original request versus exact candidate</caption>
        <thead>
          <tr>
            <th>Field</th>
            <th>Agent request</th>
            <th>Exact candidate {differs ? "(differs)" : ""}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, left, right, cls]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>
                <Mono>{left}</Mono>
              </td>
              <td className={cls}>
                <Mono className="data">{right}</Mono>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {request.rationale !== undefined && request.rationale.length > 0 && (
        <p className="muted small">
          Agent rationale (not an input to the decision): <em>{request.rationale}</em>
        </p>
      )}

      <div className="drawer-grid">
        <div>
          <h4>Decision</h4>
          {receipt === null ? (
            <p className="muted small">{loading ? "Loading…" : "No receipt loaded."}</p>
          ) : (
            <>
              <StateBadge presentation={decisionOutcome(receipt.outcome)} showNote />
              {receipt.reasons.length > 0 ? (
                <ul className="reasons">
                  {receipt.reasons.map((code) => (
                    <li key={code}>
                      <Mono>{code}</Mono>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted small">No reason codes.</p>
              )}
              {limiting.length > 0 && (
                <>
                  <h5>Limiting rule{limiting.length === 1 ? "" : "s"}</h5>
                  <ul className="reasons">
                    {limiting.map((check) => (
                      <li key={check.rule}>
                        <Badge tone="amber" glyph="◆">
                          {check.rule}
                        </Badge>{" "}
                        <Mono className="data">
                          observed {check.observed ?? "–"} · limit {check.limit ?? "–"} {check.unit ?? ""}
                        </Mono>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {failing.length > 0 && (
                <>
                  <h5>Failed rules</h5>
                  <ul className="reasons">
                    {failing.map((check) => (
                      <li key={check.rule}>
                        <Badge tone="red" glyph="✕">
                          {check.rule}
                        </Badge>{" "}
                        <Mono className="data">
                          observed {check.observed ?? "–"} · limit {check.limit ?? "–"} {check.unit ?? ""}
                        </Mono>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          )}
        </div>
        <div>
          <h4>Observation age</h4>
          {receipt === null ? (
            <p className="muted small">–</p>
          ) : (
            <DefList
              items={[
                [
                  "Evaluated",
                  <>
                    <Timestamp iso={receipt.evaluated_at} /> · <Mono>{fmtAge(receipt.evaluated_at, serverNow)}</Mono>
                  </>,
                ],
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
                  "Intent observations",
                  <Mono>{(request.observation_ids ?? []).map(shortId).join(", ") || "none"}</Mono>,
                ],
              ]}
            />
          )}
          <h4>Authority</h4>
          <DefList items={authority} />
        </div>
      </div>

      <h4>Reservations</h4>
      {detail === null || detail.reservations.length === 0 ? (
        <p className="muted small">{detail === null ? "–" : "No reservations recorded for this proposal."}</p>
      ) : (
        <ul className="plain">
          {detail.reservations.map((reservation) => {
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
      {detail !== null && detail.approvals.length > 0 && (
        <p className="muted small">
          Existing approvals:{" "}
          {detail.approvals.map((approval) => `${shortId(approval.id)} (${approval.status})`).join(", ")}
        </p>
      )}

      <div className="drawer-actions">
        {proposal.state === "COLLECTING" && (
          <p className="state-message">
            <Badge tone="amber" glyph="◔">
              collection window running
            </Badge>{" "}
            Opposing intents are still being collected; approval opens when the window closes.
          </p>
        )}
        {proposal.state === "CONFLICT_HELD" && (
          <p className="state-message">
            <Badge tone="amber" glyph="⚠">
              conflict held
            </Badge>{" "}
            Resolve it in the <a href="#conflicts">conflict panel</a> before any approval.
          </p>
        )}
        {proposal.state === "APPROVED" && (
          <p className="state-message">
            <Badge tone="neutral" glyph="◇">
              approved · not submitted
            </Badge>{" "}
            The approval is stored. Dispatch revalidates policy, lease, epoch, and price drift before arming.
          </p>
        )}
        {proposal.state === "COMMAND_CREATED" && (
          <p className="state-message">
            <Badge tone="neutral" glyph="▷">
              approved, awaiting dispatch
            </Badge>{" "}
            Not submitted, not filled. Follow the command in the <a href="#commands">Commands panel</a>.
          </p>
        )}
        {expired && proposal.state === "AWAITING_APPROVAL" && (
          <p className="state-message">
            <Badge tone="muted" glyph="⌛">
              expired
            </Badge>{" "}
            This proposal's approval window passed on the server clock; the kernel will not accept an approval.
          </p>
        )}
        {approvable && (
          <label className="confirm-label">
            <input
              type="checkbox"
              data-testid="approve-confirm"
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
              disabled={approveInFlight}
            />{" "}
            I approve exactly this candidate:{" "}
            <Mono className="data">
              {trimDecimal(candidate.quantity)} {base}
            </Mono>{" "}
            at <Mono className="data">{trimDecimal(candidate.limit_price)}</Mono>, revision{" "}
            <Mono>{proposal.revision}</Mono>, hash{" "}
            <Mono title={proposal.proposal_hash}>{shortHash(proposal.proposal_hash)}</Mono>, epoch{" "}
            <Mono>{proposal.account_epoch}</Mono>
          </label>
        )}
        <div className="button-row">
          <button
            type="button"
            className="btn btn-primary"
            data-testid="approve-button"
            onClick={() => onApprove(proposal)}
            disabled={!approvable || !confirmed || approveInFlight}
            title={approvable ? undefined : `Not approvable in state ${proposal.state}`}
          >
            {approveInFlight ? "Approving…" : "Approve exactly this candidate"}
          </button>
          {rejectable && (
            <>
              <label htmlFor="reject-reason" className="sr-only">
                Reject reason
              </label>
              <input
                id="reject-reason"
                className="reason-input"
                placeholder="Reject reason (optional)"
                maxLength={200}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                disabled={rejectInFlight}
              />
              <button
                type="button"
                className="btn btn-danger"
                data-testid="reject-button"
                onClick={() => onReject(proposal, reason.trim().length > 0 ? reason.trim() : undefined)}
                disabled={rejectInFlight}
              >
                {rejectInFlight ? "Rejecting…" : "Reject"}
              </button>
            </>
          )}
        </div>
        <p className="muted small">
          Approval stores an exact, single-use authorization bound to this revision, hash, and epoch. It is not a
          submission and not a fill.
        </p>
      </div>
    </section>
  );
}
