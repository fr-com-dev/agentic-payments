// @vitest-environment jsdom
// 013 web toolchain: JSX compiles and renders in jsdom under vitest (specs/013 research R10).
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("013 web toolchain", () => {
  it("renders a component in jsdom", () => {
    render(<p>portal</p>);
    expect(screen.getByText("portal")).toBeTruthy();
  });
});
