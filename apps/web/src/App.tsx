import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient, describeError, type KernelClient, KernelError, type RestoredSession } from "./api.ts";
import { AgentsPanel, type AgentTokenReveal } from "./components/AgentsPanel.tsx";
import { ApprovalDrawer } from "./components/ApprovalDrawer.tsx";
import { CommandsPanel } from "./components/CommandsPanel.tsx";
import { ConflictPanel } from "./components/ConflictPanel.tsx";
import { Badge, Modal, Mono, type Toast, Toasts } from "./components/common.tsx";
import { DecisionQueue } from "./components/DecisionQueue.tsx";
import { IncidentsPanel } from "./components/IncidentsPanel.tsx";
import { IntegrationPanel } from "./components/IntegrationPanel.tsx";
import { Login } from "./components/Login.tsx";
import { PolicyPanel } from "./components/PolicyPanel.tsx";
import { ReceiptView, type Selection } from "./components/ReceiptView.tsx";
import { StatusStrip } from "./components/StatusStrip.tsx";
import { Timeline } from "./components/Timeline.tsx";
import { TopBar } from "./components/TopBar.tsx";
import { UnknownBanner } from "./components/UnknownBanner.tsx";
import { downloadJson, type EventRefs, shortId } from "./format.ts";
import { ACTION, mergeEvents, useDetail, useEventStream, useKernelData, useMutationRunner, useNow } from "./hooks.ts";
import { incidentSeverity } from "./states.ts";
import type {
  Agent,
  AuditEvent,
  CommandDetail,
  CommandRecord,
  ConflictListItem,
  Incident,
  IntentDocument,
  IssueLeaseRequest,
  ProposalListItem,
  ReadinessCheck,
  RegisterAgentRequest,
} from "./types.ts";

interface Session {
  csrfToken: string;
  operatorId: string;
  expiresAt: string;
}

type Dialog =
  | { kind: "stop" }
  | { kind: "resume" }
  | { kind: "quarantine"; agent: Agent }
  | { kind: "revoke"; lease: { lease_id: string; agent_id: string } }
  | { kind: "reject-both"; conflict: ConflictListItem };

function fetchDocument(client: KernelClient, key: string): Promise<IntentDocument> {
  const separator = key.indexOf(":");
  const kind = key.slice(0, separator);
  const id = key.slice(separator + 1);
  return kind === "intent" ? client.intentDocument(id) : client.proposalDocument(id);
}

function fetchCommand(client: KernelClient, id: string): Promise<CommandDetail> {
  return client.command(id);
}

function parseChecks(details: unknown): ReadinessCheck[] {
  const list = Array.isArray(details)
    ? details
    : typeof details === "object" && details !== null
      ? (details as { checks?: unknown }).checks
      : null;
  if (!Array.isArray(list)) return [];
  const checks: ReadinessCheck[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const check = item as Record<string, unknown>;
    if (typeof check.name === "string") {
      checks.push({
        name: check.name,
        ok: check.ok === true,
        detail: typeof check.detail === "string" ? check.detail : "",
      });
    }
  }
  return checks;
}

function StopDialog({
  inFlight,
  onConfirm,
  onClose,
}: {
  inFlight: boolean;
  onConfirm: (reason: string | undefined) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Modal title="Stop new orders" onClose={onClose} testId="stop-dialog">
      <p>
        Pauses the account: no new command can be armed and pending approvals are invalidated. Commands already armed
        are not cancelled; they keep reconciling and stay visible until resolved.
      </p>
      <div className="form-row">
        <label htmlFor="stop-reason">Reason (optional, recorded on the audit event)</label>
        <input id="stop-reason" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
      </div>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-danger"
          data-testid="stop-confirm"
          onClick={() => onConfirm(reason.trim().length > 0 ? reason.trim() : undefined)}
          disabled={inFlight}
        >
          {inFlight ? "Stopping…" : "Confirm: stop new orders"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={inFlight}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function ResumeDialog({
  checks,
  incidents,
  inFlightCommands,
  unresolvedCommands,
  inFlight,
  serverChecks,
  serverMessage,
  onConfirm,
  onClose,
}: {
  checks: ReadinessCheck[];
  incidents: Incident[];
  inFlightCommands: number;
  unresolvedCommands: number;
  inFlight: boolean;
  serverChecks: ReadinessCheck[];
  serverMessage: string | null;
  onConfirm: (acknowledged: string[]) => void;
  onClose: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  const failing = (serverChecks.length > 0 ? serverChecks : checks).filter((check) => !check.ok);
  const critical = incidents.filter((incident) => incident.status === "OPEN" && incident.severity === "CRITICAL");
  const outstanding = inFlightCommands + unresolvedCommands;
  const toggle = (id: string): void => {
    setAcknowledged((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return (
    <Modal title="Resume account" onClose={onClose} testId="resume-dialog" wide>
      <p>
        Resume requires zero outstanding commands and every readiness check passing. Acknowledging an incident records
        your review on the audit log; it does not change what the kernel knows.
      </p>
      <p>
        Outstanding commands: <Mono className="data">{inFlightCommands}</Mono> in flight,{" "}
        <Mono className="data">{unresolvedCommands}</Mono> unresolved.{" "}
        {outstanding > 0 && <span className="tone-amber">Reconcile them in the Commands panel first.</span>}
      </p>
      <h4>Readiness checks</h4>
      {failing.length === 0 ? (
        <p className="muted small">All checks passing.</p>
      ) : (
        <ul className="plain checks-list">
          {failing.map((check) => (
            <li key={check.name} className="tone-amber">
              <span className="glyph" aria-hidden="true">
                ✕
              </span>{" "}
              <Mono>{check.name}</Mono> <span className="muted small">{check.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <h4>Open CRITICAL incidents</h4>
      {critical.length === 0 ? (
        <p className="muted small">None open.</p>
      ) : (
        <ul className="plain">
          {critical.map((incident) => {
            const severity = incidentSeverity(incident.severity);
            return (
              <li key={incident.id}>
                <label className="inline-label">
                  <input type="checkbox" checked={acknowledged.has(incident.id)} onChange={() => toggle(incident.id)} />{" "}
                  <Badge tone={severity.tone} glyph={severity.glyph}>
                    {severity.label}
                  </Badge>{" "}
                  {incident.type} · <Mono className="muted small">{shortId(incident.id)}</Mono>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {serverMessage !== null && (
        <p className="error-note">
          <span className="glyph" aria-hidden="true">
            ✕
          </span>
          {serverMessage}
        </p>
      )}
      <div className="button-row">
        <button
          type="button"
          className="btn btn-primary"
          data-testid="resume-confirm"
          onClick={() => onConfirm([...acknowledged])}
          disabled={inFlight || outstanding > 0}
          title={outstanding > 0 ? "Outstanding commands must be reconciled first" : undefined}
        >
          {inFlight ? "Resuming…" : "Resume"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={inFlight}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  testId,
  inFlight,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  testId: string;
  inFlight: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal title={title} onClose={onClose} testId={testId}>
      <p>{body}</p>
      <div className="button-row">
        <button
          type="button"
          className="btn btn-danger"
          data-testid={`${testId}-confirm`}
          onClick={onConfirm}
          disabled={inFlight}
        >
          {inFlight ? "Working…" : confirmLabel}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose} disabled={inFlight}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const csrfRef = useRef<string | null>(null);
  const client = useMemo(
    () =>
      createClient({
        getCsrf: () => csrfRef.current,
        onUnauthorized: () => {
          csrfRef.current = null;
          setSession(null);
        },
      }),
    [],
  );
  const loggedIn = session !== null;

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const pushToast = useCallback((kind: Toast["kind"], title: string, detail?: string) => {
    const id = ++toastSeq.current;
    setToasts((prev) => [...prev.slice(-4), detail === undefined ? { id, kind, title } : { id, kind, title, detail }]);
    window.setTimeout(
      () => setToasts((prev) => prev.filter((toast) => toast.id !== id)),
      kind === "error" ? 15_000 : 8_000,
    );
  }, []);
  const dismissToast = useCallback((id: number) => setToasts((prev) => prev.filter((toast) => toast.id !== id)), []);

  const { snapshot, refresh: refreshData, refreshing } = useKernelData(client, loggedIn);
  const now = useNow(1000);
  const serverNow = now + snapshot.serverOffsetMs;

  const [selection, setSelection] = useState<Selection | null>(null);
  const detailKey = loggedIn && selection !== null ? `${selection.kind}:${selection.id}` : null;
  const detail = useDetail(client, detailKey, fetchDocument);

  const [expandedCommandId, setExpandedCommandId] = useState<string | null>(null);
  const commandDetail = useDetail(client, loggedIn ? expandedCommandId : null, fetchCommand);

  const reloadDetail = detail.reload;
  const reloadCommand = commandDetail.reload;
  const refreshAll = useCallback(() => {
    refreshData();
    reloadDetail();
    reloadCommand();
  }, [refreshData, reloadDetail, reloadCommand]);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const refreshTimer = useRef<number | null>(null);
  const handleEvents = useCallback(
    (incoming: AuditEvent[]) => {
      setEvents((prev) => mergeEvents(prev, incoming));
      if (refreshTimer.current !== null) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        refreshAll();
      }, 150);
    },
    [refreshAll],
  );
  const stream = useEventStream(client, loggedIn, handleEvents);
  useEffect(
    () => () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    },
    [],
  );

  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [tokenReveal, setTokenReveal] = useState<AgentTokenReveal | null>(null);
  const [resumeFailure, setResumeFailure] = useState<{ message: string; checks: ReadinessCheck[] } | null>(null);

  useEffect(() => {
    if (loggedIn) return;
    setEvents([]);
    setSelection(null);
    setExpandedCommandId(null);
    setDialog(null);
    setTokenReveal(null);
    setResumeFailure(null);
  }, [loggedIn]);

  const runnerOptions = useMemo(
    () => ({
      onSettled: refreshAll,
      onError: (error: unknown, actionId: string) => {
        const action = actionId.split(":")[0] ?? "action";
        let extra: string | undefined;
        if (error instanceof KernelError) {
          const parts: string[] = [];
          if (error.requestId !== null) parts.push(`request ${error.requestId}`);
          if (error.details !== undefined) parts.push(JSON.stringify(error.details).slice(0, 240));
          extra = parts.length > 0 ? parts.join(" · ") : undefined;
        }
        pushToast("error", `${action} failed — ${describeError(error)}`, extra);
      },
    }),
    [refreshAll, pushToast],
  );
  const runner = useMutationRunner(runnerOptions);

  const agentsById = useMemo(
    () => new Map(snapshot.agents.map((agent) => [agent.id, agent] as const)),
    [snapshot.agents],
  );
  const proposals = useMemo(() => snapshot.proposals?.proposals ?? [], [snapshot.proposals]);
  const conflicts = useMemo(() => snapshot.proposals?.conflicts ?? [], [snapshot.proposals]);
  const proposalsById = useMemo(
    () => new Map(proposals.map((proposal) => [proposal.proposal_id, proposal] as const)),
    [proposals],
  );
  const account = snapshot.overview?.account ?? snapshot.status?.account ?? null;
  const quoteAsset = account?.quote_asset;
  const selectedProposal = selection?.kind === "proposal" ? proposalsById.get(selection.id) : undefined;

  const handleLoggedIn = (response: RestoredSession): void => {
    csrfRef.current = response.csrf_token;
    setSession({ csrfToken: response.csrf_token, operatorId: response.operator_id, expiresAt: response.expires_at });
  };

  // A reload keeps the HttpOnly cookie; the CSRF token is re-issued for it, otherwise the login screen shows.
  useEffect(() => {
    let cancelled = false;
    client
      .restore()
      .then((restored) => {
        if (!cancelled) handleLoggedIn(restored);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client]);

  const logout = async (): Promise<void> => {
    try {
      await client.logout();
    } catch {
      // The session is dropped locally regardless; the cookie expires server-side.
    }
    csrfRef.current = null;
    setSession(null);
  };

  const approve = async (proposal: ProposalListItem): Promise<void> => {
    const result = await runner.run(ACTION.approve(proposal.proposal_id, proposal.revision), (key) =>
      client.approve(
        proposal.proposal_id,
        {
          proposal_revision: proposal.revision,
          proposal_hash: proposal.proposal_hash,
          expected_account_epoch: proposal.account_epoch,
          operator_confirmation: true,
        },
        key,
      ),
    );
    if (result.ok) {
      pushToast(
        "info",
        `Approval stored (${result.value.state})`,
        result.value.note ?? "Not submitted, not filled. Dispatch revalidates before arming.",
      );
    }
  };

  const reject = async (proposal: ProposalListItem, reason: string | undefined): Promise<void> => {
    const result = await runner.run(ACTION.reject(proposal.proposal_id), (key) =>
      client.reject(proposal.proposal_id, reason, key),
    );
    if (result.ok) pushToast("info", `Proposal ${shortId(proposal.proposal_id)} rejected`);
  };

  const selectConflict = async (conflict: ConflictListItem, proposalId: string): Promise<void> => {
    const result = await runner.run(ACTION.conflictSelect(conflict.conflict_id, proposalId), (key) =>
      client.resolveConflict(conflict.conflict_id, { action: "SELECT", proposal_id: proposalId }, key),
    );
    if (result.ok)
      pushToast("info", `Conflict resolved: selected ${shortId(proposalId)}`, "The other proposal is rejected.");
  };

  const confirmDialog = async (): Promise<void> => {
    if (dialog === null) return;
    switch (dialog.kind) {
      case "quarantine": {
        const agent = dialog.agent;
        const result = await runner.run(ACTION.quarantine(agent.id), (key) => client.quarantine(agent.id, key));
        if (result.ok)
          pushToast(
            "info",
            `Agent ${agent.name} quarantined`,
            "New authority is blocked until an operator reviews it.",
          );
        break;
      }
      case "revoke": {
        const lease = dialog.lease;
        const result = await runner.run(ACTION.revokeLease(lease.lease_id), (key) =>
          client.revokeLease(lease.lease_id, key),
        );
        if (result.ok) pushToast("info", `Lease ${shortId(lease.lease_id)} revoked`);
        break;
      }
      case "reject-both": {
        const conflict = dialog.conflict;
        const result = await runner.run(ACTION.conflictRejectBoth(conflict.conflict_id), (key) =>
          client.resolveConflict(conflict.conflict_id, { action: "REJECT_BOTH" }, key),
        );
        if (result.ok) pushToast("info", `Conflict ${shortId(conflict.conflict_id)}: both proposals rejected`);
        break;
      }
      default:
        return;
    }
    setDialog(null);
  };

  const stop = async (reason: string | undefined): Promise<void> => {
    const result = await runner.run(ACTION.stop, (key) => client.stop(reason, key));
    if (result.ok) {
      const value = result.value;
      pushToast(
        "info",
        `Account ${value.status} (epoch ${value.epoch})`,
        `${value.in_flight_commands.length} in flight · ${value.invalidated_proposals} proposals and ${value.invalidated_approvals} approvals invalidated. ${value.note}`,
      );
    }
    setDialog(null);
  };

  const resume = async (acknowledged: string[]): Promise<void> => {
    setResumeFailure(null);
    const result = await runner.run(ACTION.resume, (key) => client.resume(acknowledged, key));
    if (result.ok) {
      pushToast(
        "success",
        `Account ${result.value.status} (epoch ${result.value.epoch})`,
        "Resumed after readiness checks passed.",
      );
      setDialog(null);
      return;
    }
    const error = result.error;
    setResumeFailure({
      message: describeError(error),
      checks: error instanceof KernelError ? parseChecks(error.details) : [],
    });
  };

  const registerAgent = async (body: RegisterAgentRequest): Promise<boolean> => {
    const result = await runner.run(ACTION.registerAgent(body.name), (key) => client.registerAgent(body, key));
    if (!result.ok) return false;
    setTokenReveal({ agent: result.value.agent, token: result.value.token, note: result.value.note });
    pushToast("info", `Agent ${result.value.agent.name} registered`, "Copy its token now; it is shown once.");
    return true;
  };

  const issueLease = async (body: IssueLeaseRequest): Promise<boolean> => {
    const result = await runner.run(ACTION.issueLease(body.agent_id, body.expires_at), (key) =>
      client.issueLease(body, key),
    );
    if (!result.ok) return false;
    pushToast(
      "info",
      "Lease issued",
      `${body.acquisition_budget_quote} ${quoteAsset ?? ""} budget · ${body.max_submission_attempts} attempts · expires ${body.expires_at}`,
    );
    return true;
  };

  const reconcile = async (command: CommandRecord): Promise<void> => {
    const result = await runner.run(ACTION.reconcile(command.id), (key) => client.reconcile(command.id, key));
    if (result.ok) pushToast("info", `Reconcile ${shortId(command.id)}: ${result.value.result}`, result.value.detail);
  };

  const openFromTimeline = (refs: EventRefs): void => {
    if (refs.proposal_id !== null) setSelection({ kind: "proposal", id: refs.proposal_id });
    else if (refs.intent_id !== null) setSelection({ kind: "intent", id: refs.intent_id });
    else return;
    document.getElementById("receipt")?.scrollIntoView({ block: "nearest" });
  };

  const exportReceipt = (): void => {
    if (detail.data === null) return;
    downloadJson(`receipt-${detail.data.intent.id}.json`, detail.data);
  };

  if (session === null) {
    return (
      <>
        <Login client={client} onLoggedIn={handleLoggedIn} />
        <Toasts toasts={toasts} onDismiss={dismissToast} />
      </>
    );
  }

  const unknownCount = snapshot.overview?.commands.OUTCOME_UNKNOWN ?? 0;
  const readinessChecks = snapshot.status?.readiness.checks ?? snapshot.overview?.readiness.checks ?? [];
  const inFlightCommands = snapshot.overview?.in_flight_commands ?? snapshot.status?.in_flight_commands ?? 0;
  const unresolvedCommands = snapshot.overview?.unresolved_commands ?? snapshot.status?.unresolved_commands ?? 0;

  return (
    <div className="console">
      <TopBar
        status={snapshot.status}
        streamStatus={stream.status}
        lastRefreshAt={snapshot.lastRefreshAt}
        now={now}
        refreshing={refreshing}
        operatorId={session.operatorId}
        stopInFlight={runner.isInFlight(ACTION.stop)}
        resumeInFlight={runner.isInFlight(ACTION.resume)}
        onRefresh={refreshAll}
        onStop={() => setDialog({ kind: "stop" })}
        onResume={() => {
          setResumeFailure(null);
          setDialog({ kind: "resume" });
        }}
        onLogout={() => void logout()}
      />
      <StatusStrip status={snapshot.status} overview={snapshot.overview} />
      {Object.keys(snapshot.errors).length > 0 && (
        <p className="banner banner-error" role="alert">
          <span className="glyph" aria-hidden="true">
            ✕
          </span>
          <span>
            Some reads failed; showing the last good values.{" "}
            {Object.entries(snapshot.errors)
              .map(([key, message]) => `${key}: ${message}`)
              .join(" · ")}
          </span>
        </p>
      )}
      <UnknownBanner unknownCount={unknownCount} accountStatus={account?.status ?? null} />
      <main className="columns">
        <div className="column column-left">
          <AgentsPanel
            agents={snapshot.agents}
            leases={snapshot.leases}
            quoteAsset={quoteAsset}
            serverNow={serverNow}
            tokenReveal={tokenReveal}
            onDismissToken={() => setTokenReveal(null)}
            onQuarantine={(agent) => setDialog({ kind: "quarantine", agent })}
            onRevokeLease={(lease) => setDialog({ kind: "revoke", lease })}
            onRegister={registerAgent}
            onIssueLease={issueLease}
            isInFlight={runner.isInFlight}
            error={snapshot.errors.agents ?? snapshot.errors.leases}
          />
          <IntegrationPanel status={snapshot.status} serverNow={serverNow} error={snapshot.errors.status} />
        </div>
        <div className="column column-center">
          <DecisionQueue
            proposals={proposals}
            agentsById={agentsById}
            quoteAsset={quoteAsset}
            serverNow={serverNow}
            selectedProposalId={selectedProposal?.proposal_id ?? null}
            onSelect={(proposalId) => setSelection({ kind: "proposal", id: proposalId })}
            error={snapshot.errors.proposals}
            loaded={snapshot.proposals !== null}
          >
            {selectedProposal !== undefined && (
              <ApprovalDrawer
                key={`${selectedProposal.proposal_id}:${selectedProposal.revision}:${selectedProposal.proposal_hash}`}
                proposal={selectedProposal}
                doc={detail.data}
                loading={detail.loading}
                error={detail.error}
                agentName={agentsById.get(selectedProposal.agent_id)?.name ?? shortId(selectedProposal.agent_id)}
                quoteAsset={quoteAsset}
                serverNow={serverNow}
                policyVersion={snapshot.policy?.version ?? null}
                approveInFlight={runner.isInFlight(
                  ACTION.approve(selectedProposal.proposal_id, selectedProposal.revision),
                )}
                rejectInFlight={runner.isInFlight(ACTION.reject(selectedProposal.proposal_id))}
                onApprove={(proposal) => void approve(proposal)}
                onReject={(proposal, reason) => void reject(proposal, reason)}
                onClose={() => setSelection(null)}
              />
            )}
            {selection?.kind === "proposal" && selectedProposal === undefined && (
              <p className="muted small drawer-note">
                Proposal <Mono>{shortId(selection.id)}</Mono> is no longer in the pre-arm queue; its receipt and linkage
                stay available on the right.
              </p>
            )}
          </DecisionQueue>
          <ConflictPanel
            conflicts={conflicts}
            proposalsById={proposalsById}
            agentsById={agentsById}
            quoteAsset={quoteAsset}
            onSelect={(conflict, proposalId) => void selectConflict(conflict, proposalId)}
            onRejectBoth={(conflict) => setDialog({ kind: "reject-both", conflict })}
            isInFlight={runner.isInFlight}
          />
          <CommandsPanel
            commands={snapshot.commands}
            expandedId={expandedCommandId}
            onToggle={(id) => setExpandedCommandId((prev) => (prev === id ? null : id))}
            detail={commandDetail.data}
            detailLoading={commandDetail.loading}
            detailError={commandDetail.error}
            onReconcile={(command) => void reconcile(command)}
            isInFlight={runner.isInFlight}
            error={snapshot.errors.commands}
          />
          <IncidentsPanel incidents={snapshot.incidents} agentsById={agentsById} error={snapshot.errors.incidents} />
        </div>
        <div className="column column-right">
          <ReceiptView
            selection={selection}
            doc={detail.data}
            loading={detail.loading}
            error={detail.error}
            serverNow={serverNow}
            agentsById={agentsById}
            onExport={exportReceipt}
          />
          <PolicyPanel policy={snapshot.policy} missing={snapshot.policyMissing} error={snapshot.errors.policy} />
        </div>
      </main>
      <Timeline events={events} streamStatus={stream.status} lastSeq={stream.lastSeq} onOpen={openFromTimeline} />
      <footer className="footer muted small">
        MoneyKernel console ·{" "}
        {snapshot.status ? `engine ${snapshot.status.engine_version}` : "kernel status not loaded"} · session expires{" "}
        <Mono>{session.expiresAt}</Mono> · every decision here is a kernel API call; the browser holds no authority.
      </footer>

      {dialog?.kind === "stop" && (
        <StopDialog
          inFlight={runner.isInFlight(ACTION.stop)}
          onConfirm={(reason) => void stop(reason)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "resume" && (
        <ResumeDialog
          checks={readinessChecks}
          incidents={snapshot.incidents}
          inFlightCommands={inFlightCommands}
          unresolvedCommands={unresolvedCommands}
          inFlight={runner.isInFlight(ACTION.resume)}
          serverChecks={resumeFailure?.checks ?? []}
          serverMessage={resumeFailure?.message ?? null}
          onConfirm={(acknowledged) => void resume(acknowledged)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "quarantine" && (
        <ConfirmDialog
          title={`Quarantine ${dialog.agent.name}`}
          body="Quarantine blocks any new authority for this agent: its lease grants nothing until an operator reviews it. Existing armed commands keep reconciling."
          confirmLabel="Quarantine agent"
          testId="quarantine-dialog"
          inFlight={runner.isInFlight(ACTION.quarantine(dialog.agent.id))}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "revoke" && (
        <ConfirmDialog
          title={`Revoke lease ${shortId(dialog.lease.lease_id)}`}
          body="Revoking removes the agent's authority to commit funds. Pending proposals under this lease are invalidated; nothing already armed is cancelled."
          confirmLabel="Revoke lease"
          testId="revoke-dialog"
          inFlight={runner.isInFlight(ACTION.revokeLease(dialog.lease.lease_id))}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "reject-both" && (
        <ConfirmDialog
          title={`Reject both proposals on ${dialog.conflict.symbol}`}
          body="Both held proposals are rejected and their reservations released. The agents may submit fresh intents."
          confirmLabel="Reject both"
          testId="reject-both-dialog"
          inFlight={runner.isInFlight(ACTION.conflictRejectBoth(dialog.conflict.conflict_id))}
          onConfirm={() => void confirmDialog()}
          onClose={() => setDialog(null)}
        />
      )}
      <Toasts toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}
