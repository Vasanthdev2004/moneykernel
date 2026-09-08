import { ArrowRight, Check, CircleDashed, Inbox } from "lucide-react";
import { amount, describeSize, eventLabel, eventRefs, fmtAge } from "../format.ts";
import type { Agent, AuditEvent, OverviewResponse, ProposalListItem, StatusResponse } from "../types.ts";
import { StatusStrip } from "./StatusStrip.tsx";
import { TokenIcon } from "./TokenIcon.tsx";
import type { WorkspacePage } from "./WorkspaceNavigation.tsx";

export function Overview({
  overview,
  status,
  agents,
  proposals,
  events,
  serverNow,
  onNavigate,
  onProposal,
  onEvent,
}: {
  overview: OverviewResponse | null;
  status: StatusResponse | null;
  agents: Agent[];
  proposals: ProposalListItem[];
  events: AuditEvent[];
  serverNow: number;
  onNavigate: (page: WorkspacePage) => void;
  onProposal: (id: string) => void;
  onEvent: (event: AuditEvent) => void;
}) {
  const pending = proposals.filter((proposal) => proposal.state === "AWAITING_APPROVAL");
  const account = overview?.account ?? status?.account;
  const incidentCount = overview ? Object.values(overview.open_incidents).reduce((sum, count) => sum + count, 0) : null;
  const attention =
    overview !== null &&
    (overview.pending_approvals > 0 ||
      overview.open_conflicts > 0 ||
      (incidentCount ?? 0) > 0 ||
      overview.unresolved_commands > 0 ||
      overview.in_flight_commands > 0 ||
      !overview.readiness.ready);
  return (
    <div className="overview-page">
      <StatusStrip status={status} overview={overview} />
      <div className="overview-grid">
        <section className="attention-section" aria-labelledby="attention-heading">
          <div className="section-heading">
            <h2 id="attention-heading">Needs your attention</h2>
            <Inbox size={19} aria-hidden="true" />
          </div>
          {overview === null ? (
            <p className="empty">Loading account state…</p>
          ) : (
            <>
              {!attention && (
                <div className="clear-state">
                  <span className="clear-check">
                    <Check size={24} aria-hidden="true" />
                  </span>
                  <h3>You’re up to date</h3>
                  <p>New requests and account issues will appear here when they need your review.</p>
                </div>
              )}
              {pending.slice(0, 3).map((proposal) => (
                <button
                  type="button"
                  className="attention-row"
                  key={proposal.proposal_id}
                  onClick={() => onProposal(proposal.proposal_id)}
                >
                  <span>
                    <strong>
                      {agents.find((agent) => agent.id === proposal.agent_id)?.name ?? "Agent"} wants to{" "}
                      {proposal.candidate.side.toLowerCase()} {proposal.candidate.symbol}
                    </strong>
                    <span className="muted">
                      Requested {describeSize(proposal.requested.size)} · review the exact candidate
                    </span>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              ))}
              {overview.pending_approvals > 0 && (
                <button className="btn btn-primary" type="button" onClick={() => onNavigate("approvals")}>
                  Review approvals <ArrowRight size={16} aria-hidden="true" />
                </button>
              )}
              {overview.open_conflicts > 0 && (
                <button className="attention-row" type="button" onClick={() => onNavigate("approvals")}>
                  <span>
                    <strong>
                      {overview.open_conflicts} opposing request{overview.open_conflicts === 1 ? "" : "s"}
                    </strong>
                    <span className="muted">Choose which proposal can move forward.</span>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
              {(incidentCount ?? 0) > 0 && (
                <button className="attention-row" type="button" onClick={() => onNavigate("activity")}>
                  <span>
                    <strong>
                      {incidentCount} open incident{incidentCount === 1 ? "" : "s"}
                    </strong>
                    <span className="muted">Review the evidence and recovery steps.</span>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
              {!overview.readiness.ready && (
                <button className="attention-row" type="button" onClick={() => onNavigate("system")}>
                  <span>
                    <strong>Account needs a check</strong>
                    <span className="muted">Review readiness before allowing new orders.</span>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
              {(overview.in_flight_commands > 0 || overview.unresolved_commands > 0) && (
                <button className="attention-row" type="button" onClick={() => onNavigate("activity")}>
                  <span>
                    <strong>Trades are still being resolved</strong>
                    <span className="muted">Follow their current state in Activity.</span>
                  </span>
                  <ArrowRight size={18} aria-hidden="true" />
                </button>
              )}
            </>
          )}
          <div className="account-health">
            <span>
              <span data-testid="in-flight">{overview?.in_flight_commands ?? status?.in_flight_commands ?? "—"}</span>{" "}
              in flight
            </span>
            <span>
              <span data-testid="unresolved">
                {overview?.unresolved_commands ?? status?.unresolved_commands ?? "—"}
              </span>{" "}
              unresolved
            </span>
            <button type="button" onClick={() => onNavigate("activity")}>
              View activity <ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        </section>
        <section className="holdings-section" aria-labelledby="holdings-heading">
          <div className="section-heading">
            <h2 id="holdings-heading">Your holdings</h2>
            <span className="muted small">
              {account?.environment === "REPLAY" || account?.environment === "SHADOW"
                ? "Virtual assets"
                : "Account assets"}
            </span>
          </div>
          {overview === null ? (
            <p className="empty">Loading balances…</p>
          ) : overview.balances.length === 0 ? (
            <p className="empty">No balances recorded.</p>
          ) : (
            <ul className="holdings-list">
              {overview.balances.map((balance) => (
                <li key={balance.asset}>
                  <TokenIcon asset={balance.asset} />
                  <strong>{balance.asset}</strong>
                  <span className="holding-quantity">{amount(balance.owned_quantity)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted">Owned balances. Reservations are shown separately above.</p>
        </section>
      </div>
      <section className="recent-section" aria-labelledby="recent-heading">
        <div className="section-heading">
          <h2 id="recent-heading">Recent activity</h2>
          <button className="text-button" type="button" onClick={() => onNavigate("activity")}>
            View all <ArrowRight size={15} aria-hidden="true" />
          </button>
        </div>
        {events.length === 0 ? (
          <p className="empty">Account events will appear here as they arrive.</p>
        ) : (
          <ul className="recent-list">
            {events.slice(0, 5).map((event) => {
              const refs = eventRefs(event);
              const canOpen = refs.intent_id !== null || refs.proposal_id !== null;
              return (
                <li key={event.id}>
                  <CircleDashed size={18} aria-hidden="true" />
                  <span className="recent-title">{eventLabel(event.type)}</span>
                  <span className="muted small">{fmtAge(event.occurred_at, serverNow)}</span>
                  {canOpen && (
                    <button className="text-button" type="button" onClick={() => onEvent(event)}>
                      Receipt <ArrowRight size={14} aria-hidden="true" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
