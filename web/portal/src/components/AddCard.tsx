// Adding a card (specs/013 US6, FR-018; contracts/card-vault.md "Add a card"). The card number and the security code
// are typed into the card vault's own fields, inside the vault's frame: they never enter this app's DOM, state or
// requests. This component only starts the setup, mounts those fields, and passes the vault's setup reference back.
import { useEffect, useRef, useState } from "react";
import { Banner, Field } from "./ui.js";
import { useApp } from "../context.js";
import { errorMessage } from "../messages.js";
import type { Card } from "../types.js";

export const STRIPE_JS_URL = "https://js.stripe.com/endive/stripe.js";
export const NICKNAME_MAX = 40;

/** The vault's fields, mounted in an element. The fake used in tests has the same shape. */
export interface CardFields {
  mount(element: HTMLElement): void;
  /** Sends what the person typed to the vault. Returns the setup reference, or a failure the person can act on. */
  confirm(): Promise<{ setupIntentId: string } | { failed: true }>;
  destroy(): void;
}
export type CardFieldsFactory = (publishableKey: string, clientSecret: string) => Promise<CardFields>;

interface StripeLike {
  elements(o: { clientSecret: string }): { create(type: "payment"): { mount(el: HTMLElement): void; destroy(): void } };
  confirmSetup(o: { elements: unknown; redirect: "if_required"; confirmParams: { return_url: string } }): Promise<{
    setupIntent?: { id: string; status: string };
    error?: unknown;
  }>;
}

let loading: Promise<void> | null = null;
/** Loads the vault's script from the vault itself, once, and only when a person opens "Add a card". */
function loadScript(): Promise<void> {
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = STRIPE_JS_URL;
    s.onload = () => resolve();
    s.onerror = () => {
      loading = null;
      reject(new Error("card fields unavailable"));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/** The real fields: Stripe's Payment Element, confirmed without a redirect when none is needed. */
export const stripeCardFields: CardFieldsFactory = async (publishableKey, clientSecret) => {
  await loadScript();
  const factory = (window as unknown as { Stripe?: (key: string) => StripeLike }).Stripe;
  if (!factory) throw new Error("card fields unavailable");
  const stripe = factory(publishableKey);
  const elements = stripe.elements({ clientSecret });
  const element = elements.create("payment");
  return {
    mount: (el) => element.mount(el),
    confirm: async () => {
      const r = await stripe.confirmSetup({ elements, redirect: "if_required", confirmParams: { return_url: `${window.location.origin}/wallet` } });
      return r.setupIntent && !r.error ? { setupIntentId: r.setupIntent.id } : { failed: true };
    },
    destroy: () => element.destroy(),
  };
};

export function AddCard({ onDone, cardFields = stripeCardFields }: { onDone(card: Card | null): void; cardFields?: CardFieldsFactory }) {
  const { api, config } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const fields = useRef<CardFields | null>(null);
  const [nickname, setNickname] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      const setup = await api.cardSetup();
      if (!live) return;
      if (!setup.ok) {
        setProblem(errorMessage(setup));
        return;
      }
      try {
        const f = await cardFields(config.cards.publishableKey ?? "", setup.data.clientSecret);
        if (!live) {
          f.destroy();
          return;
        }
        fields.current = f;
        if (host.current) f.mount(host.current);
        setReady(true);
      } catch {
        if (live) setProblem("The card could not be added. Try again later.");
      }
    })();
    return () => {
      live = false;
      fields.current?.destroy();
      fields.current = null;
    };
  }, [api, cardFields, config.cards.publishableKey]);

  const save = async () => {
    if (!fields.current || busy) return;
    setBusy(true);
    setProblem(null);
    const confirmed = await fields.current.confirm();
    if ("failed" in confirmed) {
      setBusy(false);
      setProblem("The card was not accepted. Check its details or try another card.");
      return;
    }
    const r = await api.confirmCard(confirmed.setupIntentId, nickname.trim());
    setBusy(false);
    if (r.ok) onDone(r.data);
    else setProblem(errorMessage(r));
  };

  return (
    <div className="add-card" aria-label="Add a card">
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      <p className="field-help">The card details go straight to the card vault. This portal never sees the card number or the security code.</p>
      <div ref={host} className="card-fields" />
      <Field label="Nickname (optional)" value={nickname} onChange={setNickname} maxLength={NICKNAME_MAX} id="card-nickname" />
      <button type="button" onClick={() => void save()} disabled={!ready || busy}>
        Save card
      </button>{" "}
      <button type="button" className="secondary" onClick={() => onDone(null)}>
        Cancel
      </button>
    </div>
  );
}
