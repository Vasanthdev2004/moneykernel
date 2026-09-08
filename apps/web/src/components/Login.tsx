import { type FormEvent, useEffect, useState } from "react";
import { describeError, type KernelClient } from "../api.ts";
import type { SessionResponse } from "../types.ts";
import { Badge } from "./common.tsx";

type Reachability = "checking" | "reachable" | "unreachable";

export function Login({
  client,
  onLoggedIn,
}: {
  client: KernelClient;
  onLoggedIn: (session: SessionResponse) => void;
}) {
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reachability, setReachability] = useState<Reachability>("checking");

  useEffect(() => {
    let disposed = false;
    client.health().then(
      () => {
        if (!disposed) setReachability("reachable");
      },
      () => {
        if (!disposed) setReachability("unreachable");
      },
    );
    return () => {
      disposed = true;
    };
  }, [client]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || secret.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const session = await client.login(secret);
      setSecret("");
      onLoggedIn(session);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-card">
        <h1 className="brand">
          Money<span className="brand-accent">Kernel</span>
        </h1>
        <p className="muted">Operator console. Renders kernel state and provenance; holds no financial authority.</p>
        <p className="login-reach">
          Kernel:{" "}
          {reachability === "checking" ? (
            <Badge tone="muted" glyph="…">
              checking
            </Badge>
          ) : reachability === "reachable" ? (
            <Badge tone="neutral" glyph="●">
              reachable
            </Badge>
          ) : (
            <Badge tone="amber" glyph="○">
              not reachable
            </Badge>
          )}
        </p>
        <form onSubmit={(event) => void submit(event)} className="login-form">
          <label htmlFor="login-secret">Operator bootstrap secret</label>
          <input
            id="login-secret"
            data-testid="login-secret"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            required
          />
          <button
            type="submit"
            data-testid="login-submit"
            className="btn btn-primary"
            disabled={busy || secret.length === 0}
          >
            {busy ? "Opening session…" : "Open operator session"}
          </button>
        </form>
        {error !== null && (
          <p className="error-note" role="alert">
            <span className="glyph" aria-hidden="true">
              ✕
            </span>
            {error}
          </p>
        )}
        <p className="muted small">
          Not connected. No session means the kernel's state is not shown; it does not mean the account is empty. The
          secret is exchanged for a short-lived HttpOnly session cookie and is never stored in the browser.
        </p>
      </div>
    </main>
  );
}
