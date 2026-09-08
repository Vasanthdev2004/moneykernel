import type {
  AgentsResponse,
  ApprovalRequest,
  ApprovalResponse,
  CommandDetail,
  CommandsResponse,
  ConflictResolution,
  EventsResponse,
  HealthLive,
  IncidentsResponse,
  IntentDocument,
  IssueLeaseRequest,
  IssueLeaseResponse,
  LeasesResponse,
  LedgerResponse,
  OverviewResponse,
  PolicyResponse,
  ProposalsResponse,
  ReconcileResponse,
  RegisterAgentRequest,
  RegisterAgentResponse,
  ResumeResponse,
  SessionResponse,
  StatusResponse,
  StopResponse,
} from "./types.ts";

/** Error envelope from the kernel (prd.md 15.7) or a transport failure (status 0). */
export class KernelError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, requestId: string | null, details?: unknown) {
    super(message);
    this.name = "KernelError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }

  /** Transport failures and server faults may be retried with the same idempotency key. */
  get retriable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof KernelError) return `${error.code}: ${error.message}`;
  if (error instanceof Error) return error.message;
  return String(error);
}

export interface ClientHandlers {
  getCsrf: () => string | null;
  onUnauthorized: () => void;
}

type Method = "GET" | "POST" | "PUT" | "DELETE";

interface RequestOptions {
  body?: unknown;
  idempotencyKey?: string;
  /** The login call's own 401 means a wrong secret, not an expired session. */
  skipUnauthorizedHandler?: boolean;
}

function parseEnvelope(
  json: unknown,
): { code: string; message: string; requestId: string | null; details: unknown } | null {
  if (typeof json !== "object" || json === null || !("error" in json)) return null;
  const raw = (json as { error: unknown }).error;
  if (typeof raw !== "object" || raw === null) return null;
  const err = raw as Record<string, unknown>;
  return {
    code: typeof err.code === "string" ? err.code : "UNKNOWN",
    message: typeof err.message === "string" ? err.message : "",
    requestId: typeof err.request_id === "string" ? err.request_id : null,
    details: err.details,
  };
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `mk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export interface KernelClient {
  login(secret: string): Promise<SessionResponse>;
  logout(): Promise<void>;
  /** Re-issues the CSRF token for a live cookie session (page reload); 401 means no session. */
  restore(): Promise<RestoredSession>;
  health(): Promise<HealthLive>;
  status(): Promise<StatusResponse>;
  overview(): Promise<OverviewResponse>;
  agents(): Promise<AgentsResponse>;
  leases(): Promise<LeasesResponse>;
  policy(): Promise<PolicyResponse>;
  proposals(): Promise<ProposalsResponse>;
  incidents(): Promise<IncidentsResponse>;
  commands(): Promise<CommandsResponse>;
  command(id: string): Promise<CommandDetail>;
  ledger(): Promise<LedgerResponse>;
  /** Sanitized run export for `pnpm verify:receipt` (prd.md 15.2, 23.4). */
  runExport(): Promise<Record<string, unknown>>;
  intentDocument(id: string): Promise<IntentDocument>;
  proposalDocument(id: string): Promise<IntentDocument>;
  eventsTail(limit: number): Promise<EventsResponse>;
  eventsAfter(after: number, limit: number): Promise<EventsResponse>;
  approve(proposalId: string, body: ApprovalRequest, key: string): Promise<ApprovalResponse>;
  reject(proposalId: string, reason: string | undefined, key: string): Promise<unknown>;
  resolveConflict(conflictId: string, body: ConflictResolution, key: string): Promise<unknown>;
  stop(reason: string | undefined, key: string): Promise<StopResponse>;
  resume(acknowledgedIncidentIds: string[], key: string): Promise<ResumeResponse>;
  registerAgent(body: RegisterAgentRequest, key: string): Promise<RegisterAgentResponse>;
  quarantine(agentId: string, key: string): Promise<unknown>;
  issueLease(body: IssueLeaseRequest, key: string): Promise<IssueLeaseResponse>;
  revokeLease(leaseId: string, key: string): Promise<unknown>;
  reconcile(commandId: string, key: string): Promise<ReconcileResponse>;
}

/**
 * Same-origin JSON client. The session cookie is HttpOnly; the CSRF token
 * lives only in memory and travels as a header on every mutation.
 */
export type RestoredSession = Pick<SessionResponse, "csrf_token" | "operator_id" | "expires_at">;

export function createClient(handlers: ClientHandlers): KernelClient {
  const request = async <T>(method: Method, path: string, options: RequestOptions = {}): Promise<T> => {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (method !== "GET") {
      if (options.body !== undefined) headers["Content-Type"] = "application/json";
      const csrf = handlers.getCsrf();
      if (csrf !== null) headers["X-CSRF-Token"] = csrf;
      if (options.idempotencyKey !== undefined) headers["Idempotency-Key"] = options.idempotencyKey;
    }
    let response: Response;
    let text: string;
    try {
      response = await fetch(path, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        credentials: "same-origin",
        cache: "no-store",
      });
      // Losing the body after receiving headers still leaves a mutation's
      // result unknown. Preserve its idempotency key through the same network error.
      text = await response.text();
    } catch (error) {
      throw new KernelError(
        0,
        "NETWORK",
        `kernel unreachable: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }
    let json: unknown = null;
    if (text.length > 0) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    if (response.status === 401 && !options.skipUnauthorizedHandler) handlers.onUnauthorized();
    if (!response.ok) {
      const envelope = parseEnvelope(json);
      throw new KernelError(
        response.status,
        envelope?.code ?? `HTTP_${response.status}`,
        envelope?.message ?? (text.length > 0 ? text.slice(0, 200) : response.statusText || "request failed"),
        envelope?.requestId ?? null,
        envelope?.details,
      );
    }
    return json as T;
  };

  const get = <T>(path: string): Promise<T> => request<T>("GET", path);
  const post = <T>(path: string, body: unknown, key: string): Promise<T> =>
    request<T>("POST", path, { body, idempotencyKey: key });
  const enc = encodeURIComponent;

  return {
    login: (secret) =>
      request<SessionResponse>("POST", "/v1/auth/session", {
        body: { bootstrap_secret: secret },
        skipUnauthorizedHandler: true,
      }),
    logout: async () => {
      await request<unknown>("DELETE", "/v1/auth/session", {
        idempotencyKey: newIdempotencyKey(),
        skipUnauthorizedHandler: true,
      });
    },
    restore: () => request<RestoredSession>("GET", "/v1/auth/session", { skipUnauthorizedHandler: true }),
    health: () => get<HealthLive>("/health/live"),
    status: () => get<StatusResponse>("/v1/status"),
    overview: () => get<OverviewResponse>("/v1/overview"),
    agents: () => get<AgentsResponse>("/v1/agents"),
    leases: () => get<LeasesResponse>("/v1/leases"),
    policy: () => get<PolicyResponse>("/v1/policy"),
    proposals: () => get<ProposalsResponse>("/v1/proposals"),
    incidents: () => get<IncidentsResponse>("/v1/incidents"),
    commands: () => get<CommandsResponse>("/v1/commands"),
    command: (id) => get<CommandDetail>(`/v1/commands/${enc(id)}`),
    ledger: () => get<LedgerResponse>("/v1/ledger"),
    runExport: () => get<Record<string, unknown>>("/v1/runs/current/export"),
    intentDocument: (id) => get<IntentDocument>(`/v1/intents/${enc(id)}`),
    proposalDocument: (id) => get<IntentDocument>(`/v1/proposals/${enc(id)}`),
    eventsTail: (limit) => get<EventsResponse>(`/v1/events?tail=1&limit=${limit}`),
    eventsAfter: (after, limit) => get<EventsResponse>(`/v1/events?after=${after}&limit=${limit}`),
    approve: (id, body, key) => post<ApprovalResponse>(`/v1/proposals/${enc(id)}/approve`, body, key),
    reject: (id, reason, key) => post<unknown>(`/v1/proposals/${enc(id)}/reject`, reason ? { reason } : {}, key),
    resolveConflict: (id, body, key) => post<unknown>(`/v1/conflicts/${enc(id)}/resolve`, body, key),
    stop: (reason, key) => post<StopResponse>("/v1/account/stop", reason ? { reason } : {}, key),
    resume: (ids, key) => post<ResumeResponse>("/v1/account/resume", { acknowledged_incident_ids: ids }, key),
    registerAgent: (body, key) => post<RegisterAgentResponse>("/v1/agents", body, key),
    quarantine: (id, key) => post<unknown>(`/v1/agents/${enc(id)}/quarantine`, {}, key),
    issueLease: (body, key) => post<IssueLeaseResponse>("/v1/leases", body, key),
    revokeLease: (id, key) => post<unknown>(`/v1/leases/${enc(id)}/revoke`, {}, key),
    reconcile: (id, key) => post<ReconcileResponse>(`/v1/commands/${enc(id)}/reconcile`, {}, key),
  };
}
