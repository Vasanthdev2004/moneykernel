import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { amount, shortId, trimDecimal } from "../format.ts";
import { ACTION } from "../hooks.ts";
import { agentStatus } from "../states.ts";
import type {
  ActiveLease,
  Agent,
  IssueLeaseRequest,
  LeaseRecord,
  RegisterAgentRequest,
  Side,
  StrategyKind,
} from "../types.ts";
import { Badge, CountdownText, DefList, Empty, ErrorNote, Mono, Panel, StateBadge, Timestamp } from "./common.tsx";

const STRATEGY_KINDS: StrategyKind[] = ["SCRIPTED", "MODEL", "RECORDED", "SUPPORTED_AGENT"];
const SIDES: Side[] = ["BUY", "SELL"];
const DECIMAL_RE = /^\d+(\.\d+)?$/;
const SYMBOL_RE = /^[A-Z0-9]{2,20}$/;

export interface AgentTokenReveal {
  agent: Agent;
  token: string;
  note: string;
}

function toLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function LeaseSummary({
  lease,
  serverNow,
  revokeInFlight,
  onRevoke,
}: {
  lease: ActiveLease;
  serverNow: number;
  revokeInFlight: boolean;
  onRevoke: () => void;
}) {
  const items: Array<[string, ReactNode]> = [
    ["Lease", <Mono title={lease.lease_id}>{shortId(lease.lease_id)}</Mono>],
    [
      "Expires",
      <>
        <CountdownText iso={lease.expires_at} serverNow={serverNow} prefix="in " /> ·{" "}
        <Timestamp iso={lease.expires_at} />
      </>,
    ],
    [
      "Allowed",
      <>
        <Mono>{lease.allowed_symbols.join(", ")}</Mono> · <Mono>{lease.allowed_sides.join(" / ")}</Mono> ·{" "}
        <Mono>{lease.allowed_order_types.join(", ")}</Mono>
      </>,
    ],
    ["Revision", <Mono>{lease.revision}</Mono>],
  ];
  return (
    <div className="lease">
      <DefList items={items} />
      <button type="button" className="btn btn-danger btn-small" onClick={onRevoke} disabled={revokeInFlight}>
        {revokeInFlight ? "Revoking…" : "Revoke lease"}
      </button>
    </div>
  );
}

function RegisterAgentForm({
  onRegister,
  isInFlight,
}: {
  onRegister: (body: RegisterAgentRequest) => Promise<boolean>;
  isInFlight: (actionId: string) => boolean;
}) {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StrategyKind>("SCRIPTED");
  const [busy, setBusy] = useState(false);
  const trimmed = name.trim();
  const inFlight = busy || (trimmed.length > 0 && isInFlight(ACTION.registerAgent(trimmed)));

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (inFlight || trimmed.length === 0) return;
    setBusy(true);
    const ok = await onRegister({ name: trimmed, strategy_kind: kind });
    setBusy(false);
    if (ok) setName("");
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <div className="form-row">
        <label htmlFor="agent-name">Name</label>
        <input id="agent-name" value={name} maxLength={64} onChange={(event) => setName(event.target.value)} required />
      </div>
      <div className="form-row">
        <label htmlFor="agent-kind">Strategy kind</label>
        <select id="agent-kind" value={kind} onChange={(event) => setKind(event.target.value as StrategyKind)}>
          {STRATEGY_KINDS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" className="btn" disabled={inFlight || trimmed.length === 0}>
        {inFlight ? "Registering…" : "Register"}
      </button>
    </form>
  );
}

function LeaseForm({
  agents,
  quoteAsset,
  serverNow,
  onIssue,
  isInFlight,
}: {
  agents: Agent[];
  quoteAsset: string | undefined;
  serverNow: number;
  onIssue: (body: IssueLeaseRequest) => Promise<boolean>;
  isInFlight: (actionId: string) => boolean;
}) {
  const [agentId, setAgentId] = useState("");
  const [budget, setBudget] = useState("");
  const [attempts, setAttempts] = useState("3");
  const [symbols, setSymbols] = useState("");
  const [sides, setSides] = useState<Side[]>(["BUY"]);
  const [expiry, setExpiry] = useState(() => toLocalInputValue(Date.now() + 3_600_000));
  const [stage, setStage] = useState<"edit" | "review">("edit");
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const activeAgents = agents.filter((agent) => agent.status === "ACTIVE");

  const build = (): { body: IssueLeaseRequest | null; problems: string[] } => {
    const found: string[] = [];
    if (agentId.length === 0) found.push("Choose an agent.");
    if (!DECIMAL_RE.test(budget.trim()))
      found.push("Budget must be a non-negative decimal string (for example 40 or 12.5).");
    const attemptsInt = Number.parseInt(attempts, 10);
    if (!/^\d+$/.test(attempts.trim()) || attemptsInt < 0 || attemptsInt > 1000) {
      found.push("Attempts must be an integer between 0 and 1000.");
    }
    const symbolList = symbols
      .split(/[\s,]+/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s.length > 0);
    if (symbolList.length === 0 || symbolList.length > 3) found.push("List 1 to 3 symbols.");
    for (const symbol of symbolList) {
      if (!SYMBOL_RE.test(symbol)) found.push(`Symbol ${symbol} must be 2-20 uppercase alphanumerics.`);
    }
    if (sides.length === 0) found.push("Allow at least one side.");
    const expiryMs = Date.parse(expiry);
    if (Number.isNaN(expiryMs)) found.push("Expiry must be a valid date and time.");
    else if (expiryMs <= serverNow) found.push("Expiry must be in the future (server time).");
    if (found.length > 0) return { body: null, problems: found };
    return {
      body: {
        agent_id: agentId,
        acquisition_budget_quote: budget.trim(),
        max_submission_attempts: attemptsInt,
        expires_at: new Date(expiryMs).toISOString(),
        allowed_symbols: [...new Set(symbolList)],
        allowed_sides: SIDES.filter((side) => sides.includes(side)),
        allowed_order_types: ["LIMIT_IOC"],
      },
      problems: [],
    };
  };

  const review = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = build();
    setProblems(result.problems);
    if (result.body !== null) setStage("review");
  };

  const issue = async (): Promise<void> => {
    const result = build();
    if (result.body === null || busy) return;
    setBusy(true);
    const ok = await onIssue(result.body);
    setBusy(false);
    if (ok) {
      setStage("edit");
      setBudget("");
      setSymbols("");
    }
  };

  const toggleSide = (side: Side): void => {
    setSides((prev) => (prev.includes(side) ? prev.filter((s) => s !== side) : [...prev, side]));
  };

  if (stage === "review") {
    const result = build();
    const body = result.body;
    if (body === null) {
      return (
        <div className="form">
          <h3>Review lease</h3>
          <ul className="problems">
            {result.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
          <button type="button" className="btn btn-ghost" onClick={() => setStage("edit")}>
            Back to edit
          </button>
        </div>
      );
    }
    const agent = agents.find((a) => a.id === body.agent_id);
    const inFlight = busy || isInFlight(ACTION.issueLease(body.agent_id, body.expires_at));
    const items: Array<[string, ReactNode]> = [
      ["Agent", `${agent?.name ?? body.agent_id} (${shortId(body.agent_id)})`],
      ["Acquisition budget", <Mono className="data">{amount(body.acquisition_budget_quote, quoteAsset)}</Mono>],
      ["Max submission attempts", <Mono className="data">{body.max_submission_attempts}</Mono>],
      ["Expires at", <Timestamp iso={body.expires_at} />],
      ["Allowed symbols", <Mono>{body.allowed_symbols.join(", ")}</Mono>],
      ["Allowed sides", <Mono>{body.allowed_sides.join(" / ")}</Mono>],
      ["Order types", <Mono>{body.allowed_order_types.join(", ")}</Mono>],
    ];
    return (
      <div className="form">
        <h3>Review lease</h3>
        <p className="muted small">
          Budget is the total quote the agent may commit through this lease; it is not a loss limit. The kernel will
          store exactly these values.
        </p>
        <DefList items={items} />
        <div className="button-row">
          <button type="button" className="btn btn-primary" onClick={() => void issue()} disabled={inFlight}>
            {inFlight ? "Issuing…" : "Issue lease"}
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => setStage("edit")} disabled={inFlight}>
            Back to edit
          </button>
        </div>
      </div>
    );
  }

  return (
    <form className="form" onSubmit={review}>
      <div className="form-row">
        <label htmlFor="lease-agent">Agent</label>
        <select id="lease-agent" value={agentId} onChange={(event) => setAgentId(event.target.value)} required>
          <option value="">Select an active agent</option>
          {activeAgents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name} · {agent.strategy_kind}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor="lease-budget">Acquisition budget ({quoteAsset ?? "quote"})</label>
        <input
          id="lease-budget"
          inputMode="decimal"
          placeholder="40"
          value={budget}
          onChange={(event) => setBudget(event.target.value)}
          required
        />
      </div>
      <div className="form-row">
        <label htmlFor="lease-attempts">Max submission attempts</label>
        <input
          id="lease-attempts"
          inputMode="numeric"
          value={attempts}
          onChange={(event) => setAttempts(event.target.value)}
          required
        />
      </div>
      <div className="form-row">
        <label htmlFor="lease-symbols">Allowed symbols (comma separated, max 3)</label>
        <input
          id="lease-symbols"
          placeholder="BTCUSDT, ETHUSDT"
          value={symbols}
          onChange={(event) => setSymbols(event.target.value)}
          required
        />
      </div>
      <fieldset className="form-row">
        <legend>Allowed sides</legend>
        {SIDES.map((side) => (
          <label key={side} className="inline-label">
            <input type="checkbox" checked={sides.includes(side)} onChange={() => toggleSide(side)} /> {side}
          </label>
        ))}
      </fieldset>
      <div className="form-row">
        <label htmlFor="lease-order-type">Order type</label>
        <input id="lease-order-type" value="LIMIT_IOC" readOnly aria-readonly="true" />
      </div>
      <div className="form-row">
        <label htmlFor="lease-expiry">Expires at (local time)</label>
        <input
          id="lease-expiry"
          type="datetime-local"
          value={expiry}
          onChange={(event) => setExpiry(event.target.value)}
          required
        />
      </div>
      {problems.length > 0 && (
        <ul className="problems" aria-live="polite">
          {problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
      <button type="submit" className="btn" disabled={activeAgents.length === 0}>
        Review lease
      </button>
      {activeAgents.length === 0 && <p className="muted small">Register an active agent first.</p>}
    </form>
  );
}

export function AgentsPanel({
  agents,
  leases,
  quoteAsset,
  serverNow,
  tokenReveal,
  onDismissToken,
  onQuarantine,
  onRevokeLease,
  onRegister,
  onIssueLease,
  isInFlight,
  error,
}: {
  agents: Agent[];
  leases: LeaseRecord[];
  quoteAsset: string | undefined;
  serverNow: number;
  tokenReveal: AgentTokenReveal | null;
  onDismissToken: () => void;
  onQuarantine: (agent: Agent) => void;
  onRevokeLease: (lease: { lease_id: string; agent_id: string }) => void;
  onRegister: (body: RegisterAgentRequest) => Promise<boolean>;
  onIssueLease: (body: IssueLeaseRequest) => Promise<boolean>;
  isInFlight: (actionId: string) => boolean;
  error?: string;
}) {
  const [copied, setCopied] = useState(false);
  const tokenSection = useRef<HTMLElement>(null);
  useEffect(() => {
    if (tokenReveal !== null) tokenSection.current?.scrollIntoView({ block: "nearest" });
  }, [tokenReveal]);
  const copyToken = async (token: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <Panel id="agents" title="Agents" subtitle={`${agents.length} registered`}>
      <ErrorNote message={error} prefix="agents" />
      {tokenReveal !== null && (
        <section className="token-reveal" aria-label="New agent token" ref={tokenSection}>
          <p>
            <strong>Token for {tokenReveal.agent.name}</strong> — shown once. The kernel stores only a hash; copy it
            now.
          </p>
          <Mono className="token">{tokenReveal.token}</Mono>
          <p className="muted small">{tokenReveal.note}</p>
          <div className="button-row">
            <button type="button" className="btn" onClick={() => void copyToken(tokenReveal.token)}>
              {copied ? "Copied" : "Copy token"}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setCopied(false);
                onDismissToken();
              }}
            >
              Dismiss (token will not be shown again)
            </button>
          </div>
        </section>
      )}
      {agents.length === 0 ? (
        <Empty>No agents registered. Register one below; it receives no authority until a lease is issued.</Empty>
      ) : (
        <ul className="list">
          {agents.map((agent) => {
            const presentation = agentStatus(agent.status);
            const lease = agent.active_lease;
            return (
              <li className="agent" data-testid="agent-row" key={agent.id}>
                <div className="agent-head">
                  <strong className="agent-name">{agent.name}</strong>
                  <StateBadge presentation={presentation} />
                </div>
                {lease !== null ? (
                  <div className="agent-summary">
                    <div>
                      <span className="muted small">Budget used</span>
                      <p className="data">
                        {trimDecimal(lease.consumed_quote)} / {amount(lease.acquisition_budget_quote, quoteAsset)}
                      </p>
                    </div>
                    <div>
                      <span className="muted small">Attempts used</span>
                      <p className="data">
                        {lease.attempts_consumed} / {lease.max_submission_attempts}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="muted small">No active lease.</p>
                )}
                <details className="agent-details">
                  <summary>Manage agent</summary>
                  <DefList
                    items={[
                      ["Agent ID", <Mono title={agent.id}>{agent.id}</Mono>],
                      ["Strategy", agent.strategy_kind],
                      ["Revision", <Mono>{agent.revision}</Mono>],
                    ]}
                  />
                  {presentation.note !== undefined && <p className="muted small">{presentation.note}</p>}
                  <div className="holdings">
                    <span className="label">Attributed holdings</span>{" "}
                    {agent.holdings.length === 0 ? (
                      <span className="muted small">none</span>
                    ) : (
                      agent.holdings.map((holding) => (
                        <Mono key={holding.asset} className="data holding">
                          {trimDecimal(holding.quantity)} {holding.asset}
                        </Mono>
                      ))
                    )}
                  </div>
                  {lease !== null && (
                    <LeaseSummary
                      lease={lease}
                      serverNow={serverNow}
                      revokeInFlight={isInFlight(ACTION.revokeLease(lease.lease_id))}
                      onRevoke={() => onRevokeLease({ lease_id: lease.lease_id, agent_id: agent.id })}
                    />
                  )}
                  {agent.status === "ACTIVE" && (
                    <button
                      type="button"
                      className="btn btn-danger btn-small"
                      onClick={() => onQuarantine(agent)}
                      disabled={isInFlight(ACTION.quarantine(agent.id))}
                    >
                      Quarantine
                    </button>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      )}
      {leases.length > 0 && (
        <details className="details">
          <summary>All leases ({leases.length})</summary>
          <table className="table">
            <thead>
              <tr>
                <th>Lease</th>
                <th>Agent</th>
                <th>Status</th>
                <th>Consumed / budget</th>
                <th>Attempts</th>
                <th>Expires</th>
              </tr>
            </thead>
            <tbody>
              {leases.map((lease) => (
                <tr key={lease.lease_id}>
                  <td>
                    <Mono title={lease.lease_id}>{shortId(lease.lease_id)}</Mono>
                  </td>
                  <td>{agents.find((agent) => agent.id === lease.agent_id)?.name ?? shortId(lease.agent_id)}</td>
                  <td>
                    <Badge tone={lease.status === "ACTIVE" ? "neutral" : "muted"}>{lease.status}</Badge>
                  </td>
                  <td>
                    <Mono className="data">
                      {trimDecimal(lease.consumed_quote)} / {amount(lease.acquisition_budget_quote, quoteAsset)}
                    </Mono>
                  </td>
                  <td>
                    <Mono className="data">
                      {lease.attempts_consumed} / {lease.max_submission_attempts}
                    </Mono>
                  </td>
                  <td>
                    <CountdownText iso={lease.expires_at} serverNow={serverNow} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      <details className="form-disclosure">
        <summary>Register agent</summary>
        <RegisterAgentForm onRegister={onRegister} isInFlight={isInFlight} />
      </details>
      <details className="form-disclosure">
        <summary>Issue lease</summary>
        <LeaseForm
          agents={agents}
          quoteAsset={quoteAsset}
          serverNow={serverNow}
          onIssue={onIssueLease}
          isInFlight={isInFlight}
        />
      </details>
    </Panel>
  );
}
