import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const workbench = readFileSync(new URL("../styles/dark-workbench.css", import.meta.url), "utf8");
const topBar = readFileSync(new URL("./TopBar.tsx", import.meta.url), "utf8");
const graphModal = readFileSync(new URL("./GraphModal.tsx", import.meta.url), "utf8");
const graphView = readFileSync(new URL("./GraphView.tsx", import.meta.url), "utf8");
const alert = readFileSync(new URL("./ui/alert.tsx", import.meta.url), "utf8");
const workbenchPrimitives = {
  Button: readFileSync(new URL("./ui/button.tsx", import.meta.url), "utf8"),
  Input: readFileSync(new URL("./ui/input.tsx", import.meta.url), "utf8"),
  Select: readFileSync(new URL("./ui/select.tsx", import.meta.url), "utf8"),
  Dialog: readFileSync(new URL("./ui/dialog.tsx", import.meta.url), "utf8"),
};

const appRoot = app.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
const trackingValues = [...app.matchAll(/letter-spacing\s*:\s*([^;}]+)/g)].map((match) => match[1].trim());
const narrowScreenStyles = app.match(
  /@media\s*\(max-width:\s*767px\)\s*\{([\s\S]*?)\}\s*@media\s*\(max-width:\s*560px\)/,
)?.[1] ?? "";
const tailwindRadiusTokens = Object.fromEntries(
  [...globals.matchAll(/--radius-(xs|sm|md|lg):\s*(\d+(?:\.\d+)?)rem/g)].map((match) => [
    match[1],
    Number(match[2]) * 16,
  ]),
);
const primitiveRadiusClasses = [
  ...new Set(
    Object.values(workbenchPrimitives).flatMap((source) =>
      [...source.matchAll(/\brounded-(xs|sm|md|lg)\b/g)].map((match) => match[1]),
    ),
  ),
].sort();

describe("Operations Canvas theme contract", () => {
  it("owns all semantic color tokens in globals.css with a dark instrument palette", () => {
    expect(globals).toContain("color-scheme: dark");
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--background:\s*#0A0E13/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--surface:\s*#11161D/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--surface-elevated:\s*#171E27/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--foreground:\s*#E6EBF0/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--foreground-secondary:\s*#8B98A5/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--border-subtle:\s*rgba\(148,\s*163,\s*184,\s*0\.12\)/);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--primary:\s*#3DDC97/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--warning:\s*#E5A50A/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--danger:\s*#F04452/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--information:\s*#8298FF/i);
  });

  it("maps tailwind theme tokens to semantic variables so themes switch at runtime", () => {
    expect(globals).toMatch(/--color-background:\s*var\(--background\)/);
    expect(globals).toMatch(/--color-foreground:\s*var\(--foreground\)/);
    expect(globals).toMatch(/--color-primary:\s*var\(--primary\)/);
    expect(globals).toMatch(/--color-destructive:\s*var\(--danger\)/);
    expect(globals).toMatch(/--color-ring:\s*var\(--ring\)/);
  });

  it("ships a light variant of the semantic tokens from the same source", () => {
    const light = globals.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(light).toContain("color-scheme: light");
    expect(light).toMatch(/--background:\s*#EEF1F4/i);
    expect(light).toMatch(/--surface:\s*#FFFFFF/i);
    expect(light).toMatch(/--foreground:\s*#161B22/i);
    expect(light).toMatch(/--primary:\s*#0B9669/i);
    expect(light).toMatch(/--warning:\s*#A96E00/i);
    expect(light).toMatch(/--danger:\s*#D63040/i);
    expect(light).toMatch(/--information:\s*#5566D6/i);
  });

  it("does not redefine semantic colors outside globals.css", () => {
    expect(appRoot).not.toMatch(/--background\s*:/);
    expect(appRoot).not.toMatch(/--primary\s*:/);
    expect(appRoot).not.toMatch(/--foreground\s*:/);
    const workbenchRoot = workbench.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(workbenchRoot).not.toMatch(/--background\s*:/);
    expect(workbenchRoot).not.toMatch(/--primary\s*:/);
    expect(workbenchRoot).not.toMatch(/--color-background\s*:/);
    expect(workbench).not.toContain("#0b0f10");
    expect(workbench).not.toContain("#79d5b6");
    expect(workbench).not.toMatch(/:root\[data-theme="light"\]\s*\{[^}]*--background\s*:/);
  });

  it("keeps the widened type scale with a reasoning size", () => {
    expect(globals).toMatch(/--type-label:\s*10px/);
    expect(globals).toMatch(/--type-meta:\s*11px/);
    expect(globals).toMatch(/--type-control:\s*12px/);
    expect(globals).toMatch(/--type-body:\s*13px/);
    expect(globals).toMatch(/--type-reasoning:\s*14px/);
    expect(globals).toMatch(/--type-heading:\s*16px/);
    expect(globals).toMatch(/--type-title:\s*20px/);
  });

  it("keeps typography tracking at zero", () => {
    expect(app).toContain("@media (prefers-reduced-motion: reduce)");
    expect(trackingValues).not.toHaveLength(0);
    expect(trackingValues).toEqual(expect.arrayContaining(["0"]));
    expect(trackingValues.every((value) => value === "0")).toBe(true);
    expect(topBar).not.toContain("tracking-tight");
    expect(alert).not.toContain("tracking-tight");
  });

  it("uses 16px text for controls and user-readable workbench body content on narrow screens", () => {
    expect(narrowScreenStyles).toMatch(
      /\.workspace-shell\[data-mode="single"\]\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
    expect(narrowScreenStyles).toMatch(
      /input,\s*textarea,\s*select,\s*\.tf-select-trigger\s*\{[^}]*font-size:\s*16px/,
    );
    expect(narrowScreenStyles).toMatch(
      /\.request-row-url,\s*\.request-row p,\s*\.message,\s*\.message\.tool,\s*\.message\.reasoning,\s*\.agent-event-content,\s*\.tf-row,\s*\.kv,\s*\.tf-row-detail pre,\s*\.request-detail pre,\s*\.tf-guide-title,\s*\.tf-guide-hint,\s*\.tf-empty,\s*\.tf-select-empty\s*\{[^}]*font-size:\s*16px/,
    );
    expect(narrowScreenStyles).toMatch(
      /\.browser-url,\s*\.flow-card-head strong,\s*\.flow-card p,\s*\.tf-gdetail-title,\s*\.tf-gdetail-kv span:last-child,\s*\.tf-gdetail-link\s*\{[^}]*font-size:\s*16px/,
    );
  });

  it("keeps workbench panels, modals, and launchers on the shared radius scale", () => {
    expect(globals).toMatch(/--radius:\s*0\.5rem/);
    expect(appRoot).not.toMatch(/--radius\s*:/);
    expect(appRoot).toMatch(/--z-header:\s*20/);
    expect(appRoot).toMatch(/--z-drawer:\s*40/);
    expect(appRoot).toMatch(/--z-modal:\s*50/);
    expect(appRoot).toMatch(/--radius-sm:\s*6px/);
    expect(appRoot).toMatch(/--radius-lg:\s*10px/);
    expect(appRoot).toMatch(/--radius-xl:\s*14px/);
    expect(app).toMatch(/\.panel\s*\{[\s\S]*?border-radius:\s*var\(--radius-lg\)/);
    expect(app).toMatch(/\.tf-launcher\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-modal\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-case-bar \.tf-create-pop\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-tag\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
    expect(app).toMatch(/\.tf-prio\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
  });

  it("maps every non-pill Tailwind radius utility used by workbench primitives within 6px to 12px", () => {
    expect(primitiveRadiusClasses).toEqual(["lg", "md", "sm", "xs"]);

    for (const radiusClass of primitiveRadiusClasses) {
      expect(tailwindRadiusTokens[radiusClass], `rounded-${radiusClass}`).toBeGreaterThanOrEqual(6);
      expect(tailwindRadiusTokens[radiusClass], `rounded-${radiusClass}`).toBeLessThanOrEqual(12);
    }
  });

  it("reserves independent rows for the console chrome, run ruler, log, and composer", () => {
    expect(workbench).toMatch(/\.chat-panel\s*\{\s*grid-template-rows:\s*auto auto auto minmax\(0,\s*1fr\) auto/);
  });

  it("fits the three-pane workbench inside the 1100px desktop breakpoint", () => {
    expect(workbench).toMatch(/@media\s*\(max-width:\s*1250px\)\s*and\s*\(min-width:\s*1100px\)[\s\S]*?\.workspace-shell\s*\{\s*grid-template-columns:\s*240px minmax\(480px,\s*1fr\) 340px/);
  });

  it("uses an accessible dialog and named graph replay controls", () => {
    expect(graphModal).toContain("<Dialog open={graphModalOpen}");
    expect(graphModal).toContain("<DialogTitle>Attack paths</DialogTitle>");
    expect(graphView).toContain('aria-label="Reset graph replay"');
    expect(graphView).toContain('aria-label="Graph replay progress"');
    expect(graphView).toContain("aria-pressed={speed === value}");
  });

  it("keeps analytical surfaces readable in light mode", () => {
    expect(workbench).toMatch(/\[data-theme="light"\] \.observer-row\s*\{[^}]*background:\s*var\(--surface-elevated\)/);
    expect(workbench).toMatch(/\[data-theme="light"\] \[data-slot="dialog-title"\]\s*\{[^}]*color:\s*var\(--foreground\)/);
    expect(workbench).toMatch(/\[data-theme="light"\] \[data-slot="dialog-close"\]\s*\{[^}]*color:\s*var\(--foreground-muted\)/);
    expect(workbench).toMatch(/\[data-theme="light"\] \.graph-modal-header\s*\{[^}]*background:\s*var\(--surface-elevated\)/);
  });

  it("keeps the settings dialog inside narrow viewports with independent content scrolling", () => {
    expect(app).toMatch(/@media\s*\(max-width:\s*759px\)[\s\S]*?\.settings-dialog\s*\{[^}]*inset:\s*8px\s*!important[^}]*translate:\s*none\s*!important/);
    expect(app).toMatch(/\.settings-content\s*\{[^}]*min-height:\s*0[^}]*overflow-y:\s*auto/);
    expect(app).toMatch(/\.settings-layout\s*\{[^}]*grid-template-columns:\s*190px minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/);
    expect(app).toMatch(/@media\s*\(max-width:\s*479px\)[\s\S]*?\.settings-footer-context \[data-slot="button"\]\s*\{[^}]*width:\s*100%/);
  });

  it("uses a compact launchpad table instead of horizontal scrolling on narrow windows", () => {
    expect(app).toMatch(/@media\s*\(max-width:\s*799px\)[\s\S]*?\.launchpad-table\s*\{[^}]*overflow-x:\s*visible/);
    expect(app).toMatch(/@media\s*\(max-width:\s*799px\)[\s\S]*?\.launchpad-table-head,[\s\S]*?\.launchpad-row\s*\{[^}]*min-width:\s*0[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) 112px 32px/);
    expect(app).toMatch(/\.launchpad-tools label,[\s\S]*?\.launchpad-tools label:focus-within\s*\{[^}]*width:\s*min\(100%,\s*320px\)/);
  });
});
