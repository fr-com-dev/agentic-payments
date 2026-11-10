// The second onboarding step (specs/013 US2; contracts/portal-ui.md "Onboarding" step 2): one button. The account is
// created by L2 and is the same on a second click, a retry or a second tab (FR-013).
import { useState } from "react";
import { Banner, ScreenHeading } from "../components/ui.js";
import { useAccount, useApp } from "../context.js";
import { errorMessage } from "../messages.js";
import type { Wallet as WalletData } from "../types.js";
import { OnboardingSteps } from "./Home.js";
import { AccountDetails } from "./Wallet.js";

export function WalletStep() {
  const { api, me, setMe, navigate } = useApp();
  const { locked } = useAccount();
  const [wallet, setWallet] = useState<WalletData | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    if (busy) return;
    setBusy(true);
    const r = await api.createAccount();
    setBusy(false);
    if (r.ok) {
      setProblem(null);
      // The step stays on screen with the new address until the person continues.
      setWallet(r.data);
    } else setProblem(errorMessage(r));
  };
  return (
    <section>
      <ScreenHeading>Create your wallet</ScreenHeading>
      <OnboardingSteps />
      {problem !== null ? <Banner kind="error">{problem}</Banner> : null}
      {wallet?.account ? (
        <>
          <AccountDetails a={wallet.account} />
          <button
            type="button"
            onClick={() => {
              setMe({ ...me, onboarding: { ...me.onboarding, wallet: true } });
              navigate("/onboarding/policy");
            }}
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <p>Your wallet is an account on the test network that only the payment service can sign with. You never see or handle a key.</p>
          <button type="button" onClick={() => void create()} disabled={busy || locked}>
            Create my wallet
          </button>
        </>
      )}
    </section>
  );
}
