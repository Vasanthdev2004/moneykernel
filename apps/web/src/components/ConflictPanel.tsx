import { shortId, trimDecimal } from "../format.ts";
import { ACTION } from "../hooks.ts";
import type { Agent, ConflictListItem, ProposalListItem } from "../types.ts";
import { Badge, Empty, Mono, Panel, Timestamp } from "./common.tsx";
import { baseAssetFor, quoteAssetFor } from "./DecisionQueue.tsx";

export function ConflictPanel({
  conflicts,
  proposalsById,
  agentsById,
  quoteAsset,
  onSelect,
  onRejectBoth,
  isInFlight,
}: {
  conflicts: ConflictListItem[];
  proposalsById: Map<string, ProposalListItem>;
  agentsById: Map<string, Agent>;
  quoteAsset: string | undefined;
  onSelect: (conflict: ConflictListItem, proposalId: string) => void;
  onRejectBoth: (conflict: ConflictListItem) => void;
  isInFlight: (actionId: string) => boolean;
}) {
  return (
    <Panel id="conflicts" title="Conflict review" subtitle={`${conflicts.length} open`}>
      {conflicts.length === 0 ? (
        <Empty>
          No opposing intents are held. A conflict appears when two agents want opposite sides of one symbol.
        </Empty>
      ) : (
        <ul className="list">
          {conflicts.map((conflict) => {
            const rejectId = ACTION.conflictRejectBoth(conflict.conflict_id);
            const busy =
              conflict.proposal_ids.some((id) => isInFlight(ACTION.conflictSelect(conflict.conflict_id, id))) ||
              isInFlight(rejectId);
            return (
              <li className="conflict" key={conflict.conflict_id}>
                <div className="conflict-head">
                  <Badge tone="amber" glyph="⚠">
                    {conflict.status}
                  </Badge>
                  <Mono>{conflict.symbol}</Mono>
                  <Mono className="muted small" title={conflict.conflict_id}>
                    {shortId(conflict.conflict_id)}
                  </Mono>
                  <span className="muted small">
                    opened <Timestamp iso={conflict.created_at} />
                  </span>
                </div>
                <div className="conflict-sides">
                  {conflict.proposal_ids.map((proposalId) => {
                    const proposal = proposalsById.get(proposalId);
                    const agent = proposal ? agentsById.get(proposal.agent_id) : undefined;
                    const quote = proposal ? quoteAssetFor(proposal, quoteAsset) : quoteAsset;
                    const base = proposal ? baseAssetFor(proposal, quote) : "base";
                    return (
                      <div className="conflict-side" key={proposalId}>
                        {proposal ? (
                          <>
                            <strong>{agent?.name ?? shortId(proposal.agent_id)}</strong>
                            <div>
                              <Mono className="data">
                                {proposal.candidate.side} {trimDecimal(proposal.candidate.quantity)} {base} @{" "}
                                {trimDecimal(proposal.candidate.limit_price)} ={" "}
                                {trimDecimal(proposal.candidate.notional_quote)} {quote ?? ""}
                              </Mono>
                            </div>
                            <div className="muted small">
                              <Mono title={proposalId}>{shortId(proposalId)}</Mono> · {proposal.state}
                            </div>
                          </>
                        ) : (
                          <div className="muted small">
                            <Mono title={proposalId}>{shortId(proposalId)}</Mono> (no longer listed)
                          </div>
                        )}
                        <button
                          type="button"
                          className="btn btn-small"
                          data-testid="conflict-select"
                          onClick={() => onSelect(conflict, proposalId)}
                          disabled={busy}
                        >
                          Select this one
                        </button>
                      </div>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-small"
                  data-testid="conflict-reject-both"
                  onClick={() => onRejectBoth(conflict)}
                  disabled={busy}
                >
                  Reject both
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
