import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.css", import.meta.url), "utf8");
const topBar = readFileSync(new URL("./TopBar.tsx", import.meta.url), "utf8");
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
  it("uses one light semantic theme", () => {
    expect(globals).not.toContain("color-scheme: dark");
    expect(globals).toMatch(/--color-background:\s*#f2f4f5/);
    expect(globals).toMatch(/--color-foreground:\s*#17232d/);
    expect(globals).toMatch(/--color-card:\s*#ffffff/);
    expect(globals).toMatch(/--color-muted:\s*#f7f8f9/);
    expect(globals).toMatch(/--color-primary:\s*#245b84/);
    expect(globals).toMatch(/--color-destructive:\s*#b4232d/);
    expect(globals).toMatch(/--color-border:\s*#d8dfe4/);
    expect(globals).toMatch(/--color-ring:\s*#4e89b5/);
    expect(appRoot).toMatch(/--success:\s*#16705c/);
    expect(appRoot).toMatch(/--warning:\s*#97550d/);
    expect(appRoot).toMatch(/--border-subtle:\s*#e9edf0/);
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
    expect(globals).toMatch(/--radius:\s*0\.4375rem/);
    expect(appRoot).not.toMatch(/--radius\s*:/);
    expect(appRoot).toMatch(/--radius-sm:\s*6px/);
    expect(appRoot).toMatch(/--radius-lg:\s*8px/);
    expect(appRoot).toMatch(/--radius-xl:\s*8px/);
    expect(app).toMatch(/\.panel\s*\{[\s\S]*?border-radius:\s*var\(--radius-lg\)/);
    expect(app).toMatch(/\.tf-launcher\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-modal\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-case-bar \.tf-create-pop\s*\{[\s\S]*?border-radius:\s*var\(--radius\)/);
    expect(app).toMatch(/\.tf-tag\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
    expect(app).toMatch(/\.tf-prio\s*\{[^}]*border-radius:\s*var\(--radius-sm\)/);
  });

  it("maps every non-pill Tailwind radius utility used by workbench primitives within 6px to 8px", () => {
    expect(primitiveRadiusClasses).toEqual(["lg", "md", "sm", "xs"]);

    for (const radiusClass of primitiveRadiusClasses) {
      expect(tailwindRadiusTokens[radiusClass], `rounded-${radiusClass}`).toBeGreaterThanOrEqual(6);
      expect(tailwindRadiusTokens[radiusClass], `rounded-${radiusClass}`).toBeLessThanOrEqual(8);
    }
  });
});
