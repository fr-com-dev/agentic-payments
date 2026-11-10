// @vitest-environment jsdom
// 013 shared components (contracts/portal-ui.md "Accessibility and layout"): labels are tied to their inputs, errors
// are announced and take focus, a dialog keeps the keyboard inside it, and a status is always a word.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmountField, Banner, Dialog, ErrorSummary, Field, StatusLabel } from "../src/components/ui.js";

afterEach(cleanup);

describe("013 web components", () => {
  it("Field: a visible label, and help and error tied to the input", () => {
    render(<Field id="f" label="Name" value="x" onChange={() => undefined} help="Only you see it." error="Enter a name." required />);
    const input = screen.getByLabelText(/^Name/);
    expect(input.id).toBe("f");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")!.split(" ");
    expect(described.map((id) => document.getElementById(id)!.textContent)).toEqual(["Only you see it.", "Enter a name."]);
  });

  it("Field: no aria-describedby and no aria-invalid when there is nothing to describe", () => {
    render(<Field label="Name" value="" onChange={() => undefined} />);
    const input = screen.getByLabelText("Name");
    expect(input.hasAttribute("aria-describedby")).toBe(false);
    expect(input.hasAttribute("aria-invalid")).toBe(false);
  });

  it("AmountField: text in, text out, with the unit beside it", async () => {
    const user = userEvent.setup();
    const Harness = () => {
      const [v, setV] = useState("");
      return <AmountField label="Per payment" value={v} onChange={setV} />;
    };
    render(<Harness />);
    const input = screen.getByLabelText("Per payment") as HTMLInputElement;
    await user.type(input, "0.0200009");
    // Exactly what was typed: nothing rounds or reformats it.
    expect(input.value).toBe("0.0200009");
    expect(input.type).toBe("text");
    expect(input.getAttribute("inputmode")).toBe("decimal");
    expect(screen.getByText("USDC")).toBeTruthy();
  });

  it("ErrorSummary: announced, takes focus, links to the fields", () => {
    render(
      <>
        <input id="policy-name" aria-label="Policy name" />
        <ErrorSummary title="The policy was not saved" items={[{ fieldId: "policy-name", message: "Name: enter a name." }, { message: "Something else." }]} />
      </>,
    );
    const summary = screen.getByRole("alert");
    expect(document.activeElement).toBe(summary);
    expect(screen.getByRole("link", { name: "Name: enter a name." }).getAttribute("href")).toBe("#policy-name");
    expect(screen.getByText("Something else.").tagName).toBe("LI");
  });

  it("ErrorSummary: renders nothing without items", () => {
    const { container } = render(<ErrorSummary title="t" items={[]} />);
    expect(container.innerHTML).toBe("");
  });

  it("Dialog: focus moves in, Tab stays inside, Escape closes, focus returns", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <button type="button">Outside</button>
          {open ? (
            <Dialog
              title="Remove this card?"
              onClose={() => {
                onClose();
                setOpen(false);
              }}
            >
              <button type="button">Remove card</button>
              <button type="button">Cancel</button>
            </Dialog>
          ) : null}
        </>
      );
    };
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Remove this card?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const first = screen.getByRole("button", { name: "Remove card" });
    const last = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(first);
    await user.tab();
    expect(document.activeElement).toBe(last);
    await user.tab();
    expect(document.activeElement).toBe(first);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(last);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("StatusLabel and Banner: the state is a word, and an error is announced", () => {
    render(
      <>
        {["active", "paused", "removed", "expired", "disabled"].map((s) => (
          <StatusLabel key={s} state={s} />
        ))}
        <Banner kind="error">It failed.</Banner>
        <Banner>For your information.</Banner>
      </>,
    );
    for (const word of ["Active", "Paused", "Removed", "Expired", "Disabled"]) expect(screen.getByText(word)).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe("It failed.");
    expect(screen.getByRole("status").textContent).toBe("For your information.");
  });
});
