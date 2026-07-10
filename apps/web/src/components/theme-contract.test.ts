import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globals = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");
const app = readFileSync(new URL("../app.css", import.meta.url), "utf8");

describe("Operations Canvas theme contract", () => {
  it("uses one light semantic theme", () => {
    expect(globals).not.toContain("color-scheme: dark");
    expect(globals).toContain("--color-background: #f2f4f5");
    expect(globals).toContain("--color-primary: #245b84");
    expect(app).toContain("--success: #16705c");
    expect(app).toContain("--warning: #97550d");
    expect(app).toContain("--z-modal: 50");
  });

  it("respects reduced motion and stable tracking", () => {
    expect(app).toContain("@media (prefers-reduced-motion: reduce)");
    expect(app).toContain("letter-spacing: 0");
  });
});
