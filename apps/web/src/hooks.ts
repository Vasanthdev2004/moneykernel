import { useCallback, useEffect, useRef, useState } from "react";
import { describeError, type KernelClient, KernelError, newIdempotencyKey } from "./api.ts";
import {
  type Agent,
  AUDIT_EVENT_TYPES,
  type AuditEvent,
  type CommandRecord,
  type Incident,
  type LeaseRecord,
  type LedgerResponse,
  type OverviewResponse,
  type PolicyResponse,
  type ProposalsResponse,
  type StatusResponse,
} from "./types.ts";

export const POLL_INTERVAL_MS = 2000;
const EVENT_TAIL = 200;
const EVENT_CAP = 600;
const STREAM_RETRY_MS = 2000;

/** Ticking wall clock for countdowns; combine with the server offset from the snapshot. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export interface KernelSnapshot {
  status: StatusResponse | null;
  overview: OverviewResponse | null;
  agents: Agent[];
  leases: LeaseRecord[];
  policy: PolicyResponse | null;
  policyMissing: boolean;
  proposals: ProposalsResponse | null;
  incidents: Incident[];
  commands: CommandRecord[];
  ledger: LedgerResponse | null;
  errors: Record<string, string>;
  serverOffsetMs: number;
  lastRefreshAt: number | null;
  loaded: boolean;
}

export const EMPTY_SNAPSHOT: KernelSnapshot = {
  status: null,
  overview: null,
  agents: [],
  leases: [],
  policy: null,
  policyMissing: false,
  proposals: null,
  incidents: [],
  commands: [],
  ledger: null,
  errors: {},
  serverOffsetMs: 0,
  lastRefreshAt: null,
  loaded: false,
};

function settle<T>(
  result: PromiseSettledResult<T>,
  previous: T,
  key: string,
  errors: Record<string, string>,
): { value: T; ok: boolean } {
  if (result.status === "fulfilled") {
    delete errors[key];
    return { value: result.value, ok: true };
  }
  errors[key] = describeError(result.reason);
  return { value: previous, ok: false };
}

/**
 * Polls every read endpoint on one cadence. Each resource keeps its last good
 * value and records its own error, so one failing endpoint never blanks the
 * console. Responses are applied in request order; a stale response never
 * overwrites a newer one.
 */
export function useKernelData(
  client: KernelClient,
  enabled: boolean,
): { snapshot: KernelSnapshot; refresh: () => void; refreshing: boolean } {
  const [snapshot, setSnapshot] = useState<KernelSnapshot>(EMPTY_SNAPSHOT);
  const [refreshing, setRefreshing] = useState(false);
  const runRef = useRef<(() => Promise<void>) | null>(null);
  const seqRef = useRef(0);
  const appliedRef = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(EMPTY_SNAPSHOT);
      runRef.current = null;
      return;
    }
    let disposed = false;
    const run = async (): Promise<void> => {
      const seq = ++seqRef.current;
      setRefreshing(true);
      const [status, overview, agents, leases, policy, proposals, incidents, commands, ledger] =
        await Promise.allSettled([
          client.status(),
          client.overview(),
          client.agents(),
          client.leases(),
          client.policy(),
          client.proposals(),
          client.incidents(),
          client.commands(),
          client.ledger(),
        ]);
      if (disposed || seq < appliedRef.current) return;
      appliedRef.current = seq;
      const receivedAt = Date.now();
      setSnapshot((prev) => {
        const errors = { ...prev.errors };
        const next: KernelSnapshot = { ...prev, errors, lastRefreshAt: receivedAt };
        const statusResult = settle(status, prev.status, "status", errors);
        next.status = statusResult.value;
        const overviewResult = settle(overview, prev.overview, "overview", errors);
        next.overview = overviewResult.value;
        next.agents = settle(agents, { agents: prev.agents }, "agents", errors).value.agents;
        next.leases = settle(leases, { leases: prev.leases }, "leases", errors).value.leases;
        if (policy.status === "fulfilled") {
          delete errors.policy;
          next.policy = policy.value;
          next.policyMissing = false;
        } else if (policy.reason instanceof KernelError && policy.reason.status === 404) {
          delete errors.policy;
          next.policy = null;
          next.policyMissing = true;
        } else {
          errors.policy = describeError(policy.reason);
        }
        next.proposals = settle(proposals, prev.proposals, "proposals", errors).value;
        next.incidents = settle(incidents, { incidents: prev.incidents }, "incidents", errors).value.incidents;
        next.commands = settle(commands, { commands: prev.commands }, "commands", errors).value.commands;
        next.ledger = settle(ledger, prev.ledger, "ledger", errors).value;
        const serverTime =
          statusResult.ok && next.status !== null
            ? next.status.server_time
            : overviewResult.ok && next.overview !== null
              ? next.overview.server_time
              : null;
        if (serverTime !== null) {
          const parsed = Date.parse(serverTime);
          if (!Number.isNaN(parsed)) next.serverOffsetMs = parsed - receivedAt;
        }
        next.loaded = prev.loaded || statusResult.ok || overviewResult.ok;
        return next;
      });
      setRefreshing(false);
    };
    runRef.current = run;
    void run();
    const id = window.setInterval(() => void run(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      runRef.current = null;
      window.clearInterval(id);
    };
  }, [client, enabled]);

  const refresh = useCallback(() => {
    void runRef.current?.();
  }, []);

  return { snapshot, refresh, refreshing };
}

export interface DetailState<T> {
  key: string | null;
  data: T | null;
  error: string | null;
  loading: boolean;
}

/** Fetches one document for a selection key; `reload` refetches the current key after mutations or events. */
export function useDetail<T>(
  client: KernelClient,
  key: string | null,
  fetcher: (client: KernelClient, key: string) => Promise<T>,
): DetailState<T> & { reload: () => void } {
  const [state, setState] = useState<DetailState<T>>({ key: null, data: null, error: null, loading: false });
  const requestRef = useRef(0);
  const keyRef = useRef<string | null>(null);

  const load = useCallback(
    (target: string) => {
      const request = ++requestRef.current;
      setState((prev) => ({ key: target, data: prev.key === target ? prev.data : null, error: null, loading: true }));
      fetcher(client, target).then(
        (data) => {
          if (request === requestRef.current) setState({ key: target, data, error: null, loading: false });
        },
        (error: unknown) => {
          if (request === requestRef.current) {
            setState((prev) => ({
              key: target,
              data: prev.key === target ? prev.data : null,
              error: describeError(error),
              loading: false,
            }));
          }
        },
      );
    },
    [client, fetcher],
  );

  useEffect(() => {
    keyRef.current = key;
    if (key === null) {
      requestRef.current += 1;
      setState({ key: null, data: null, error: null, loading: false });
      return;
    }
    load(key);
  }, [key, load]);

  const reload = useCallback(() => {
    if (keyRef.current !== null) load(keyRef.current);
  }, [load]);

  return { ...state, reload };
}

export type StreamStatus = "off" | "loading" | "live" | "reconnecting";

/** Newest first, deduplicated by event id, capped. */
export function mergeEvents(previous: AuditEvent[], incoming: AuditEvent[]): AuditEvent[] {
  if (incoming.length === 0) return previous;
  const byId = new Map<string, AuditEvent>();
  for (const event of previous) byId.set(event.id, event);
  let changed = false;
  for (const event of incoming) {
    if (!byId.has(event.id)) changed = true;
    byId.set(event.id, event);
  }
  if (!changed) return previous;
  return [...byId.values()].sort((a, b) => b.account_seq - a.account_seq).slice(0, EVENT_CAP);
}

function parseEventFrame(raw: unknown): AuditEvent | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const event = parsed as Partial<AuditEvent>;
    if (typeof event.id !== "string" || typeof event.type !== "string" || typeof event.account_seq !== "number") {
      return null;
    }
    return {
      id: event.id,
      account_seq: event.account_seq,
      type: event.type,
      payload: typeof event.payload === "object" && event.payload !== null ? event.payload : {},
      payload_hash: typeof event.payload_hash === "string" ? event.payload_hash : "",
      previous_hash: typeof event.previous_hash === "string" ? event.previous_hash : null,
      event_hash: typeof event.event_hash === "string" ? event.event_hash : "",
      occurred_at: typeof event.occurred_at === "string" ? event.occurred_at : "",
    };
  } catch {
    return null;
  }
}

/**
 * Timeline feed: one page of the most recent events for first paint, then the
 * SSE stream from the last seen account_seq. Deliveries may repeat; callers
 * deduplicate by id. A dropped stream reconnects from the last seen sequence.
 */
export function useEventStream(
  client: KernelClient,
  enabled: boolean,
  onEvents: (events: AuditEvent[]) => void,
): { status: StreamStatus; lastSeq: number } {
  const [status, setStatus] = useState<StreamStatus>("off");
  const [lastSeq, setLastSeq] = useState(0);
  const onEventsRef = useRef(onEvents);
  const lastSeqRef = useRef(0);

  useEffect(() => {
    onEventsRef.current = onEvents;
  }, [onEvents]);

  useEffect(() => {
    if (!enabled) {
      setStatus("off");
      lastSeqRef.current = 0;
      setLastSeq(0);
      return;
    }
    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;

    const deliver = (events: AuditEvent[]): void => {
      if (events.length === 0) return;
      for (const event of events) {
        if (event.account_seq > lastSeqRef.current) lastSeqRef.current = event.account_seq;
      }
      setLastSeq(lastSeqRef.current);
      onEventsRef.current(events);
    };

    const handleFrame = (frame: Event): void => {
      if (!(frame instanceof MessageEvent)) return;
      const event = parseEventFrame(frame.data);
      if (event !== null) deliver([event]);
    };

    const connect = (): void => {
      if (disposed) return;
      const stream = new EventSource(`/v1/events/stream?after=${lastSeqRef.current}`);
      source = stream;
      for (const type of AUDIT_EVENT_TYPES) stream.addEventListener(type, handleFrame);
      stream.onmessage = handleFrame;
      stream.onopen = () => {
        if (!disposed) setStatus("live");
      };
      stream.onerror = () => {
        if (disposed) return;
        stream.close();
        if (source === stream) source = null;
        setStatus("reconnecting");
        retryTimer = window.setTimeout(connect, STREAM_RETRY_MS);
      };
    };

    setStatus("loading");
    client.eventsTail(EVENT_TAIL).then(
      (page) => {
        if (disposed) return;
        deliver(page.events);
        connect();
      },
      () => {
        if (!disposed) connect();
      },
    );

    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [client, enabled]);

  return { status, lastSeq };
}

export type MutationResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

export interface MutationRunner {
  run: <T>(actionId: string, fn: (idempotencyKey: string) => Promise<T>) => Promise<MutationResult<T>>;
  isInFlight: (actionId: string) => boolean;
  inFlightCount: number;
}

/**
 * One idempotency key per click. The key is kept for a retry of the same
 * action after a transport or server fault, and dropped once the kernel has
 * answered with a product result (2xx or 4xx). A click is ignored while the
 * same action is in flight; the backend enforces idempotency regardless.
 */
export function useMutationRunner(options: {
  onSettled: () => void;
  onError: (error: unknown, actionId: string) => void;
}): MutationRunner {
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const keysRef = useRef<Map<string, string>>(new Map());
  const optionsRef = useRef(options);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const run = useCallback(
    async <T>(actionId: string, fn: (idempotencyKey: string) => Promise<T>): Promise<MutationResult<T>> => {
      if (inFlightRef.current.has(actionId)) return { ok: false, error: new Error("action already in flight") };
      const key = keysRef.current.get(actionId) ?? newIdempotencyKey();
      keysRef.current.set(actionId, key);
      inFlightRef.current.add(actionId);
      setInFlight(new Set(inFlightRef.current));
      try {
        const value = await fn(key);
        keysRef.current.delete(actionId);
        return { ok: true, value };
      } catch (error) {
        if (!(error instanceof KernelError && error.retriable)) keysRef.current.delete(actionId);
        optionsRef.current.onError(error, actionId);
        return { ok: false, error };
      } finally {
        inFlightRef.current.delete(actionId);
        setInFlight(new Set(inFlightRef.current));
        optionsRef.current.onSettled();
      }
    },
    [],
  );

  const isInFlight = useCallback((actionId: string) => inFlight.has(actionId), [inFlight]);

  return { run, isInFlight, inFlightCount: inFlight.size };
}

/** Stable action identifiers so a retry of the same click reuses its idempotency key. */
export const ACTION = {
  approve: (proposalId: string, revision: number) => `approve:${proposalId}:${revision}`,
  reject: (proposalId: string) => `reject:${proposalId}`,
  conflictSelect: (conflictId: string, proposalId: string) => `conflict:${conflictId}:select:${proposalId}`,
  conflictRejectBoth: (conflictId: string) => `conflict:${conflictId}:reject-both`,
  stop: "account:stop",
  resume: "account:resume",
  registerAgent: (name: string) => `agent:register:${name}`,
  quarantine: (agentId: string) => `agent:${agentId}:quarantine`,
  issueLease: (agentId: string, expiresAt: string) => `lease:issue:${agentId}:${expiresAt}`,
  revokeLease: (leaseId: string) => `lease:${leaseId}:revoke`,
  reconcile: (commandId: string) => `command:${commandId}:reconcile`,
} as const;
