import { type ReactNode, useEffect, useId, useRef } from "react";
import { countdown, fmtTs } from "../format.ts";
import type { Presentation, Tone } from "../states.ts";

export function Badge({
  tone,
  glyph,
  children,
  title,
  testId,
  className,
}: {
  tone: Tone;
  glyph?: string;
  children: ReactNode;
  title?: string;
  testId?: string;
  className?: string;
}) {
  return (
    <span className={`badge badge-${tone}${className ? ` ${className}` : ""}`} title={title} data-testid={testId}>
      {glyph !== undefined && (
        <span className="glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      <span>{children}</span>
    </span>
  );
}

export function StateBadge({
  presentation,
  testId,
  showNote,
}: {
  presentation: Presentation;
  testId?: string;
  showNote?: boolean;
}) {
  return (
    <>
      <Badge tone={presentation.tone} glyph={presentation.glyph} title={presentation.note} testId={testId}>
        {presentation.label}
      </Badge>
      {showNote && presentation.note !== undefined && <span className="state-note">{presentation.note}</span>}
    </>
  );
}

export function Panel({
  id,
  title,
  subtitle,
  actions,
  children,
  className,
}: {
  id?: string;
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section className={className ? `panel ${className}` : "panel"} id={id} aria-labelledby={headingId}>
      <header className="panel-header">
        <div>
          <h2 id={headingId}>{title}</h2>
          {subtitle !== undefined && <p className="panel-subtitle">{subtitle}</p>}
        </div>
        {actions !== undefined && <div className="panel-actions">{actions}</div>}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function Mono({ children, title, className }: { children: ReactNode; title?: string; className?: string }) {
  return (
    <span className={className ? `mono ${className}` : "mono"} title={title}>
      {children}
    </span>
  );
}

export function DefList({
  items,
  className,
}: {
  items: ReadonlyArray<readonly [string, ReactNode]>;
  className?: string;
}) {
  return (
    <dl className={className ? `deflist ${className}` : "deflist"}>
      {items.map(([label, value]) => (
        <div className="deflist-row" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

export function ErrorNote({ message, prefix }: { message: string | null | undefined; prefix?: string }) {
  if (!message) return null;
  return (
    <p className="error-note">
      <span className="glyph" aria-hidden="true">
        ✕
      </span>
      {prefix ? `${prefix}: ` : ""}
      {message}
    </p>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <pre className="json">{text}</pre>;
}

export function Timestamp({ iso }: { iso: string | null | undefined }) {
  return <Mono title={iso ?? undefined}>{fmtTs(iso)}</Mono>;
}

export function CountdownText({
  iso,
  serverNow,
  prefix,
}: {
  iso: string | null | undefined;
  serverNow: number;
  prefix?: string;
}) {
  const value = countdown(iso, serverNow);
  const className = value.expired
    ? "mono countdown expired"
    : value.urgent
      ? "mono countdown urgent"
      : "mono countdown";
  return (
    <span className={className} title={iso ? `expires_at ${iso}` : undefined}>
      {prefix ?? ""}
      {value.text}
    </span>
  );
}

/** Native modal dialog: focus containment, Escape to close, backdrop. Render it only while open. */
export function Modal({
  title,
  onClose,
  children,
  testId,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (!element.open) element.showModal();
    return () => {
      if (element.open) element.close();
    };
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // The `close` event is queued asynchronously. Under React StrictMode the mount effect runs, cleans up
    // (closing the dialog) and runs again (reopening it) before that event fires, so only a dialog that is
    // actually closed when the event arrives counts as an operator-initiated close (Escape, close button).
    const handleClose = (): void => {
      if (!element.open) onClose();
    };
    element.addEventListener("close", handleClose);
    return () => element.removeEventListener("close", handleClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className={wide ? "modal modal-wide" : "modal"} aria-labelledby={headingId} data-testid={testId}>
      <div className="modal-frame">
        <header className="modal-header">
          <h2 id={headingId}>{title}</h2>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => ref.current?.close()}
            aria-label="Close dialog"
          >
            ✕
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </dialog>
  );
}

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  title: string;
  detail?: string;
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <section className="toasts" aria-live="polite" aria-label="Notifications">
      {toasts.map((toast) => (
        <div className={`toast toast-${toast.kind}`} key={toast.id}>
          <div className="toast-text">
            <strong>{toast.title}</strong>
            {toast.detail !== undefined && <div className="toast-detail">{toast.detail}</div>}
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => onDismiss(toast.id)}
            aria-label="Dismiss notification"
          >
            ✕
          </button>
        </div>
      ))}
    </section>
  );
}
