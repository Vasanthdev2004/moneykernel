import type { ReactNode } from "react";
import { baseAssetOf, describeSize, shortId, trimDecimal } from "../format.ts";
import { proposalState } from "../states.ts";
import type { Agent, ProposalListItem } from "../types.ts";
import { Badge, CountdownText, Empty, ErrorNote, Mono, Panel, StateBadge } from "./common.tsx";

const STATE_ORDER: Record<string, number> = {
  AWAITING_APPROVAL: 0,
  CONFLICT_HELD: 1,
  COLLECTING: 2,
  APPROVED: 3,
  COMMAND_CREATED: 4,
};

function rank(state: string): number {
  return STATE_ORDER[state] ?? 9;
}

export function quoteAssetFor(proposal: ProposalListItem, fallback: string | undefined): string | undefined {
  return proposal.requested.size.kind === "QUOTE_NOTIONAL" ? proposal.requested.size.quote_asset : fallback;
}

export function baseAssetFor(proposal: ProposalListItem, quoteAsset: string | undefined): string {
  return proposal.requested.size.kind === "BASE_QUANTITY"
    ? proposal.requested.size.base_asset
    : baseAssetOf(proposal.candidate.symbol, quoteAsset);
}

/** True when the exact candidate is not the request as submitted (size or limit changed). */
export function differsFromRequest(proposal: ProposalListItem): boolean {
  const size = proposal.requested.size;
  const requestedAmount = trimDecimal(size.amount);
  const candidateAmount =
    size.kind === "QUOTE_NOTIONAL"
      ? trimDecimal(proposal.candidate.notional_quote)
      : trimDecimal(proposal.candidate.quantity);
  return (
    requestedAmount !== candidateAmount ||
    trimDecimal(proposal.requested.limit_price) !== trimDecimal(proposal.candidate.limit_price) ||
    proposal.requested.symbol !== proposal.candidate.symbol ||
    proposal.requested.side !== proposal.candidate.side
  );
}

export function DecisionQueue({
  proposals,
  agentsById,
  quoteAsset,
  serverNow,
  selectedProposalId,
  onSelect,
  error,
  loaded,
  children,
}: {
  proposals: ProposalListItem[];
  agentsById: Map<string, Agent>;
  quoteAsset: string | undefined;
  serverNow: number;
  selectedProposalId: string | null;
  onSelect: (proposalId: string) => void;
  error?: string;
  loaded: boolean;
  children?: ReactNode;
}) {
  const sorted = [...proposals].sort((a, b) => {
    const byState = rank(a.state) - rank(b.state);
    return byState !== 0 ? byState : a.created_at.localeCompare(b.created_at);
  });
  const pending = proposals.filter((p) => p.state === "AWAITING_APPROVAL").length;

  return (
    <Panel
      id="queue"
      title="Decision / approval queue"
      subtitle={
        loaded
          ? `${pending} awaiting approval · ${proposals.length} pre-arm proposal${proposals.length === 1 ? "" : "s"}`
          : "loading"
      }
    >
      <ErrorNote message={error} prefix="proposals" />
      {sorted.length === 0 ? (
        <Empty>
          No pending proposals. An agent's intent appears here after the kernel evaluates it; a denial is recorded on
          the timeline and in its receipt, not here.
        </Empty>
      ) : (
        <ul className="list">
          {sorted.map((proposal) => {
            const presentation = proposalState(proposal.state);
            const quote = quoteAssetFor(proposal, quoteAsset);
            const base = baseAssetFor(proposal, quote);
            const selected = proposal.proposal_id === selectedProposalId;
            const agent = agentsById.get(proposal.agent_id);
            return (
              <li
                className={selected ? "row proposal selected" : "row proposal"}
                data-testid="proposal-row"
                data-proposal-id={proposal.proposal_id}
                data-state={proposal.state}
                key={proposal.proposal_id}
              >
                <button
                  type="button"
                  className="row-main"
                  onClick={() => onSelect(proposal.proposal_id)}
                  aria-pressed={selected}
                  aria-label={`Open proposal ${proposal.proposal_id}`}
                >
                  <span className="row-line">
                    <strong>{agent?.name ?? shortId(proposal.agent_id)}</strong>
                    <span className="muted"> · </span>
                    <Mono>
                      {proposal.candidate.side} {proposal.candidate.symbol}
                    </Mono>
                  </span>
                  <span className="row-line small">
                    requested <Mono>{describeSize(proposal.requested.size)}</Mono> @{" "}
                    <Mono>{trimDecimal(proposal.requested.limit_price)}</Mono>
                  </span>
                  <span className="row-line small">
                    candidate{" "}
                    <Mono className="data">
                      {trimDecimal(proposal.candidate.quantity)} {base} @ {trimDecimal(proposal.candidate.limit_price)}{" "}
                      = {trimDecimal(proposal.candidate.notional_quote)} {quote ?? ""}
                    </Mono>
                    {differsFromRequest(proposal) && (
                      <>
                        {" "}
                        <Badge tone="amber" glyph="◆">
                          differs from request
                        </Badge>
                      </>
                    )}
                  </span>
                </button>
                <div className="row-side">
                  <StateBadge presentation={presentation} />
                  <CountdownText iso={proposal.expires_at} serverNow={serverNow} prefix="expires in " />
                  {proposal.state === "CONFLICT_HELD" && (
                    <a href="#conflicts" className="small">
                      open conflict panel
                    </a>
                  )}
                  <Mono className="small muted" title={proposal.proposal_id}>
                    {shortId(proposal.proposal_id)} r{proposal.revision}
                  </Mono>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {children}
    </Panel>
  );
}
