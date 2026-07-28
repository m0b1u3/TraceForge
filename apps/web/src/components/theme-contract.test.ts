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
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--background:\s*#0C1015/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--surface:\s*#12171D/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--surface-elevated:\s*#181F27/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--foreground:\s*#E6EBF0/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--foreground-secondary:\s*#9AA6B2/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--border-subtle:\s*rgba\(164,\s*176,\s*188,\s*0\.10\)/);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--primary:\s*#35C48D/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--warning:\s*#E5A50A/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--danger:\s*#F04452/i);
    expect(globals).toMatch(/:root\s*\{[\s\S]*?--information:\s*#8298FF/i);
  });

  it("maps tailwind theme tokens to semantic variables so themes switch at runtime", () => {
    expect(globals).toMatch(/--color-background:\s*var\(--background\)/);
    expect(globals).toMatch(/--color-foreground:\s*var\(--foreground\)/);
    expect(globals).toMatch(/--color-primary:\s*var\(--primary\)/);
    expect(globals).toMatch(/--color-cta:\s*var\(--cta\)/);
    expect(globals).toMatch(/--color-cta-hover:\s*var\(--cta-hover\)/);
    expect(globals).toMatch(/--color-destructive:\s*var\(--danger\)/);
    expect(globals).toMatch(/--color-ring:\s*var\(--ring\)/);
  });

  it("ships a light variant of the semantic tokens from the same source", () => {
    const light = globals.match(/:root\[data-theme="light"\]\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(light).toContain("color-scheme: light");
    expect(light).toMatch(/--background:\s*#F2F4F5/i);
    expect(light).toMatch(/--surface:\s*#FFFFFF/i);
    expect(light).toMatch(/--foreground:\s*#17212B/i);
    expect(light).toMatch(/--primary:\s*#087F5B/i);
    expect(light).toMatch(/--cta:\s*#087F5B/i);
    expect(light).toMatch(/--cta-hover:\s*#066A4B/i);
    expect(light).toMatch(/--warning:\s*#B45309/i);
    expect(light).toMatch(/--danger:\s*#D92D20/i);
    expect(light).toMatch(/--information:\s*#4F5BD5/i);
  });

  it("anchors calls to action on a deep professional accent in every theme", () => {
    const dark = globals.match(/:root\s*\{([\s\S]*?)\}/)?.[1] ?? "";
    expect(dark).toMatch(/--cta:\s*#0D8F68/i);
    expect(dark).toMatch(/--cta-hover:\s*#0A7958/i);
    expect(dark).toMatch(/--cta-foreground:\s*#FFFFFF/i);
    expect(workbench).not.toMatch(/\.tf-btn-primary\s*\{[^}]*background:\s*var\(--primary\)/);
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

  it("keeps the product type scale with a reasoning size", () => {
    expect(globals).toMatch(/--type-label:\s*11px/);
    expect(globals).toMatch(/--type-meta:\s*12px/);
    expect(globals).toMatch(/--type-code:\s*12px/);
    expect(globals).toMatch(/--type-control:\s*13px/);
    expect(globals).toMatch(/--type-body:\s*13px/);
    expect(globals).toMatch(/--type-reasoning:\s*14px/);
    expect(globals).toMatch(/--type-card:\s*15px/);
    expect(globals).toMatch(/--type-heading:\s*18px/);
    expect(globals).toMatch(/--type-title:\s*26px/);
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
      /\.browser-url,\s*\.flow-title,\s*\.flow-sub\s*\{[^}]*font-size:\s*16px/,
    );
  });

  it("keeps workbench panels, modals, and launchers on the shared radius scale", () => {
    expect(globals).toMatch(/--radius:\s*0\.5rem/);
    expect(appRoot).not.toMatch(/--radius\s*:/);
    expect(appRoot).toMatch(/--z-header:\s*20/);
    expect(appRoot).toMatch(/--z-drawer:\s*40/);
    expect(appRoot).toMatch(/--z-modal:\s*50/);
    expect(appRoot).toMatch(/--radius-sm:\s*6px/);
    expect(appRoot).toMatch(/--radius-lg:\s*12px/);
    expect(appRoot).toMatch(/--radius-xl:\s*16px/);
    expect(app).toMatch(/\.panel\s*\{[\s\S]*?border-radius:\s*var\(--radius-lg\)/);
    expect(app).toMatch(/\.tf-launcher\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-modal\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-case-bar \.tf-create-pop\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-tag\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
    expect(app).toMatch(/\.tf-prio\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
  });

  it("maps every Tailwind radius utility used by workbench primitives to its hierarchy tier", () => {
    const tierByClass: Record<string, number> = { xs: 5, sm: 6, md: 8, lg: 12, xl: 16 };
    expect(primitiveRadiusClasses.length).toBeGreaterThan(0);

    for (const radiusClass of primitiveRadiusClasses) {
      expect(tailwindRadiusTokens[radiusClass], `rounded-${radiusClass}`).toBe(tierByClass[radiusClass]);
    }
  });

  it("reserves independent rows for the console chrome, run ruler, log, and composer", () => {
    expect(workbench).toMatch(/\.chat-panel\s*\{\s*grid-template-rows:\s*auto auto minmax\(0,\s*1fr\) auto/);
  });

  it("fits the three-pane workbench inside the 1100px desktop breakpoint", () => {
    expect(workbench).toMatch(/@media\s*\(max-width:\s*1250px\)\s*and\s*\(min-width:\s*1100px\)[\s\S]*?\.workspace-shell\s*\{\s*grid-template-columns:\s*232px minmax\(0,\s*1fr\) 320px/);
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

  it("uses a compact launchpad list instead of a data table", () => {
    expect(app).not.toContain("launchpad-table-head");
    expect(app).toMatch(/\.launchpad-list\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/);
    expect(app).toMatch(/\.launchpad-row-main\s*\{[^}]*display:\s*grid[^}]*cursor:\s*pointer/);
    expect(app).toMatch(/@media\s*\(max-width:\s*799px\)[\s\S]*?\.launchpad-row-meta \.launchpad-number,[\s\S]*?display:\s*none/);
    expect(app).toMatch(/\.launchpad-tools label,[\s\S]*?\.launchpad-tools label:focus-within\s*\{[^}]*width:\s*min\(100%,\s*320px\)/);
  });

  it("gives the primary investigation call to action real weight", () => {
    expect(app).toMatch(/\.launchpad-create-primary\s*\{[^}]*height:\s*44px/);
    expect(workbenchPrimitives.Button).toMatch(/default:\s*"[^"]*bg-cta[^"]*font-semibold[^"]*hover:bg-cta-hover/);
    expect(app).toMatch(/\.launchpad-start\s*\{[^}]*display:\s*grid[^}]*gap:\s*18px/);
    expect(app).toMatch(/\.launchpad-readiness\s*\{[^}]*padding:[^}]*\}(?![\s\S]*?\.launchpad-readiness\s*\{[^}]*border)/);
  });

  it("reserves state green for live signals in every theme", () => {
    expect(workbench).not.toMatch(/\.capture-summary\s*>\s*div:first-child\s*strong\s*\{[^}]*color:\s*var\(--primary\)/);
    expect(workbench).not.toMatch(/\.capture-readiness-block\s+svg\s*\{[^}]*color:\s*var\(--primary\)/);
    expect(workbench).not.toMatch(/\.capture-readiness-block\s+strong\s*\{[^}]*color:\s*#7fcfb2/i);
    expect(workbench).toMatch(/\.capture-readiness-block\s+strong\s*\{[^}]*color:\s*var\(--foreground-secondary\)/);
    expect(workbench).not.toMatch(/\.topbar-runtime\s*>\s*\[data-slot="badge"\]\s+svg\s*\{[^}]*color:\s*var\(--primary\)/);
    expect(app).not.toMatch(/\.launchpad-agent\s+svg\s*\{[^}]*color:\s*var\(--success\)/);
    expect(app).not.toMatch(/\.launchpad-status\[data-status="idle"\][^{]*\{[^}]*color:\s*var\(--success\)/);
  });

  it("keeps interactive states on their own tokens instead of borrowed hues", () => {
    expect(app).toMatch(/\.tf-btn-primary:hover\s*\{[^}]*background:\s*var\(--cta-hover\)/);
    expect(app).not.toMatch(/\.tf-btn-primary:hover\s*\{[^}]*#1d4ed8/i);
    expect(app).toMatch(/\.launchpad-row\[data-selected="true"\]::before\s*\{[^}]*background:\s*var\(--primary\)/);
    expect(app).toMatch(/\.launchpad-row\[data-selected="true"\]\s*\{[^}]*color-mix\(in\s+srgb,\s*var\(--primary\)/);
    expect(workbench).toMatch(/\.graph-footer\s+input\[type="range"\]\s*\{[^}]*accent-color:\s*var\(--information\)/);
    expect(workbench).toMatch(/\.request-row\.is-open::before,\s*\.request-row\.is-selected::before\s*\{[^}]*background:\s*var\(--information\)/);
  });

  it("renders disabled primary buttons as neutral chrome instead of a washed tint", () => {
    expect(workbenchPrimitives.Button).toMatch(/default:\s*"[^"]*disabled:bg-secondary[^"]*disabled:text-muted-foreground/);
  });

  it("keeps ref-forwarding on primitives that Radix Slot triggers compose", () => {
    // React 18 drops refs passed to plain function components; without
    // forwardRef, floating menus anchored to Button lose their anchor
    // measurement and render outside the viewport.
    expect(workbenchPrimitives.Button).toContain("React.forwardRef");
  });

  it("routes light overrides through the shared tokens with no legacy green palette", () => {
    expect(workbench).not.toMatch(/#16815f|#147657|#116d50|#7fcfb2|#8fb8aa|#e3efeb|#d8eae4|#dce9e5|#79c8aa/i);
    expect(workbench).toMatch(/\[data-theme="light"\] \.tf-btn-primary\s*\{[^}]*background:\s*var\(--cta\)[^}]*color:\s*var\(--cta-foreground\)/);
    expect(workbench).toMatch(/\[data-theme="light"\] \.traffic-panel\s*\{[^}]*background:\s*var\(--background\)/);
  });
});
