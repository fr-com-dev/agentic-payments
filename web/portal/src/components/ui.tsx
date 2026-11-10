// Shared building blocks (specs/013 contracts/portal-ui.md "Accessibility and layout", NFR-009). Every input has a
// visible label; help and errors are tied to it with aria-describedby; errors are announced; a status is always
// words, never color alone. Everything typed by a person is rendered as text.
import { useEffect, useId, useRef, type ReactNode } from "react";

export interface FieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  help?: string;
  error?: string;
  type?: "text" | "email" | "date";
  inputMode?: "decimal" | "numeric" | "text" | "email";
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** A fixed id, so an error summary can link to the field. */
  id?: string;
  suffix?: string;
  autoComplete?: string;
}

export function Field(p: FieldProps) {
  const auto = useId();
  const id = p.id ?? auto;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const described = [p.help !== undefined && helpId, p.error !== undefined && errorId].filter(Boolean).join(" ");
  return (
    <div className={p.error !== undefined ? "field field-invalid" : "field"}>
      <label htmlFor={id}>
        {p.label}
        {p.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="field-control">
        <input
          id={id}
          type={p.type ?? "text"}
          inputMode={p.inputMode}
          value={p.value}
          required={p.required}
          disabled={p.disabled}
          maxLength={p.maxLength}
          autoComplete={p.autoComplete ?? "off"}
          aria-invalid={p.error !== undefined ? true : undefined}
          aria-describedby={described === "" ? undefined : described}
          onChange={(e) => p.onChange(e.target.value)}
        />
        {p.suffix !== undefined ? <span className="field-suffix">{p.suffix}</span> : null}
      </div>
      {p.help !== undefined ? (
        <p id={helpId} className="field-help">
          {p.help}
        </p>
      ) : null}
      {p.error !== undefined ? (
        <p id={errorId} className="field-error">
          {p.error}
        </p>
      ) : null}
    </div>
  );
}

/** An amount in USDC. Text in, text out: nothing here turns it into a number (FR-025). */
export function AmountField(p: Omit<FieldProps, "type" | "inputMode" | "suffix">) {
  return <Field {...p} inputMode="decimal" suffix="USDC" />;
}

export interface SummaryItem {
  /** The id of the field to jump to, if the problem belongs to one. */
  fieldId?: string;
  message: string;
}

/** Announced as soon as it appears, and takes focus, so a keyboard or screen-reader user lands on the problems. */
export function ErrorSummary({ title, items }: { title: string; items: SummaryItem[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const key = items.map((i) => i.message).join("|");
  useEffect(() => {
    if (items.length > 0) ref.current?.focus();
  }, [key, items.length]);
  if (items.length === 0) return null;
  return (
    <div ref={ref} className="error-summary" role="alert" tabIndex={-1}>
      <h2>{title}</h2>
      <ul>
        {items.map((item) => (
          <li key={`${item.fieldId ?? ""}:${item.message}`}>{item.fieldId !== undefined ? <a href={`#${item.fieldId}`}>{item.message}</a> : item.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function Banner({ kind = "info", children }: { kind?: "info" | "warning" | "error"; children: ReactNode }) {
  return (
    <div className={`banner banner-${kind}`} role={kind === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}

const STATUS_TEXT: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  removed: "Removed",
  expired: "Expired",
  disabled: "Disabled",
};

/** The state as a word (with a class for color). Never color alone. */
export function StatusLabel({ state }: { state: string }) {
  return <span className={`status status-${state}`}>{STATUS_TEXT[state] ?? state}</span>;
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DialogProps {
  title: string;
  onClose(): void;
  children: ReactNode;
}

/** A modal dialog: focus moves in, Tab stays inside, Escape closes, and focus returns to where it was. */
export function Dialog({ title, onClose, children }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const first = node?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node)?.focus();
    return () => before?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="dialog-backdrop">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

/** Moves focus to a screen's heading when the screen appears, so a keyboard user knows where they are. */
export function ScreenHeading({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <h1 ref={ref} tabIndex={-1}>
      {children}
    </h1>
  );
}
