import { useEffect, useState } from "react";

// G1 placeholder: shows the kernel's truthful status and provenance. The full
// operations console (prd.md section 17) arrives in G5 against frozen contracts.
type Status = Record<string, unknown>;

export function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/v1/status")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setStatus((await r.json()) as Status);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        background: "#0b0b0c",
        color: "#f3efe6",
        minHeight: "100vh",
        padding: 24,
      }}
    >
      <h1 style={{ fontSize: 20, margin: 0 }}>
        MoneyKernel <span style={{ color: "#d4af37" }}>operations console</span>
      </h1>
      <p style={{ opacity: 0.8 }}>Give AI agents capital, not blind trust.</p>
      {error && <p style={{ color: "#e5484d" }}>Kernel unreachable: {error}</p>}
      {status && (
        <pre
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 13,
            background: "#141416",
            padding: 16,
            overflowX: "auto",
          }}
        >
          {JSON.stringify(status, null, 2)}
        </pre>
      )}
      {!status && !error && <p>Loading kernel status…</p>}
    </main>
  );
}
