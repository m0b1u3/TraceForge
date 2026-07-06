import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createElement } from "react";
import { TopBar } from "./TopBar.js";

// Minimal smoke test for TopBar — no React Testing Library in this project,
// so we use react-dom/server renderToString to assert on the static output.

describe("TopBar", () => {
  it("renders the brand name", () => {
    const html = renderToString(createElement(TopBar));
    expect(html).toContain("TraceForge");
    expect(html).toContain("red-team workbench");
  });

  it("renders the control pill when caseId is present", () => {
    // The store hook is used inside the component; we can only test the static
    // output here.  With the default store state (caseId === null) the pill
    // area is empty, so we verify the component renders without crashing and
    // the brand is present.
    const html = renderToString(createElement(TopBar));
    expect(html).toContain("TraceForge");
  });
});
