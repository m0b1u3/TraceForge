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
  it("uses one dark semantic theme", () => {
    expect(globals).toContain("color-scheme: dark");
    expect(globals).toMatch(/--color-background:\s*#070d12/);
    expect(globals).toMatch(/--color-foreground:\s*#e8eef1/);
    expect(globals).toMatch(/--color-card:\s*#0b141b/);
    expect(globals).toMatch(/--color-muted:\s*#101c24/);
    expect(globals).toMatch(/--color-primary:\s*#27b47e/);
    expect(globals).toMatch(/--color-destructive:\s*#ed5d62/);
    expect(globals).toMatch(/--color-border:\s*#1b2a34/);
    expect(globals).toMatch(/--color-ring:\s*#4acb98/);
    expect(appRoot).toMatch(/--success:\s*#43cb91/);
    expect(appRoot).toMatch(/--information:\s*#5b9ff5/);
    expect(appRoot).toMatch(/--warning:\s*#e9a23b/);
    expect(appRoot).toContain("--border-subtle: rgba(126, 156, 174, 0.14)");
    expect(appRoot).toMatch(/--z-header:\s*20/);
    expect(appRoot).toMatch(/--z-drawer:\s*40/);
    expect(appRoot).toMatch(/--z-modal:\s*50/);
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

  it("reserves independent rows for the console log, composer, and run phase", () => {
    expect(workbench).toMatch(/\.chat-panel\s*\{\s*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto auto/);
  });

  it("fits the three-pane workbench inside the 1100px desktop breakpoint", () => {
    expect(workbench).toMatch(/@media\s*\(max-width:\s*1250px\)\s*and\s*\(min-width:\s*1100px\)[\s\S]*?\.workspace-shell\s*\{\s*grid-template-columns:\s*240px minmax\(480px,\s*1fr\) 340px/);
  });

  it("uses an accessible dialog and named graph replay controls", () => {
    expect(graphModal).toContain("<Dialog open={graphModalOpen}");
    expect(graphModal).toContain("<DialogTitle>Reasoning chain</DialogTitle>");
    expect(graphView).toContain('aria-label="Reset graph replay"');
    expect(graphView).toContain('aria-label="Graph replay progress"');
    expect(graphView).toContain("aria-pressed={speed === value}");
  });
});
