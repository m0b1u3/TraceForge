# Operations Canvas Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the TraceForge web workbench as the approved light, Agent-first Operations Canvas without changing backend contracts or existing product behavior.

**Architecture:** Keep React, Zustand, Tailwind v4, shadcn/Radix, and the current API/WebSocket data flow. Introduce one responsive workspace coordinator, split the oversized Agent panel into presentation-focused units, and consolidate all visual tokens into one light theme shared by legacy CSS and shadcn components.

**Tech Stack:** React 18, TypeScript 5.9, Zustand 5, Tailwind CSS 4, Radix UI/shadcn, Phosphor Icons, Vitest 3, Vite 6.

## Global Constraints

- Read every source and test file explicitly as UTF-8.
- Do not add a frontend framework, state manager, icon library, font package, or animation dependency.
- Preserve all existing backend API, WebSocket, Agent Run, Token, Traffic, Knowledge, MCP, Graph, Scope, Approval, and Observer contracts.
- Use Geist Sans for interface text, Noto Sans SC for Chinese fallback, and Geist Mono for commands, URLs, time, status codes, and token counts.
- Use 4px/8px spacing, 6px-8px workbench radii, letter-spacing `0`, and semantic color tokens.
- Desktop body text may use 13px-14px; widths below 768px use at least 16px for input and body text.
- All icon-only controls require an accessible label and tooltip.
- All LLM-triggering validation must use the configured real LLM. Mock LLMs are prohibited.
- Do not stage or modify unrelated untracked migration, memory, or personal files.

---

## File Structure

### New files

- `apps/web/src/components/WorkspaceLayout.tsx` - responsive pane selection, drawer state, and keyboard dismissal.
- `apps/web/src/components/WorkspaceLayout.test.ts` - viewport-mode and panel-selection contracts.
- `apps/web/src/components/agent/agent-conversation.ts` - event formatting, noise filtering, conversation item construction, and intervention outcome types.
- `apps/web/src/components/agent/AgentEventRow.tsx` - visual presentation for user, Agent, Reasoning, tool, and error events.
- `apps/web/src/components/agent/AgentInterventionCard.tsx` - Approval and Scope request/result presentation.
- `apps/web/src/components/agent/AgentRunHeader.tsx` - Run id, elapsed state, streaming state, Token summary, Clear, and Stop controls.
- `apps/web/src/components/PanelErrorBoundary.tsx` - local panel failure fallback with retry.
- `apps/web/src/components/theme-contract.test.ts` - light-theme and token regression contract.

### Modified files

- `apps/web/src/App.tsx` - compose the new workspace coordinator and accessible global notices.
- `apps/web/src/styles/globals.css` - replace conflicting dark shadcn tokens with the approved light semantic theme.
- `apps/web/src/app.css` - implement Operations Canvas layout, components, responsive modes, reduced motion, and z-index scale.
- `apps/web/src/components/TopBar.tsx` - consolidate Case, Run, Token, Settings, and narrow-screen panel controls.
- `apps/web/src/components/TopBar.test.ts` - verify global status rendering.
- `apps/web/src/components/TrafficPanel.tsx` - accessible request rows and evidence-stream hierarchy.
- `apps/web/src/components/TrafficPanel.test.ts` - verify time/status formatting and response tone mapping.
- `apps/web/src/components/AgentPanel.tsx` - retain orchestration and API calls while delegating presentation.
- `apps/web/src/components/AgentPanel.test.ts` - move conversation tests to the extracted module and add intervention lifecycle coverage.
- `apps/web/src/components/KnowledgePanel.tsx` - accessible dense tabs, panel counts, responsive heading, and error isolation.
- `apps/web/src/components/SettingsModal.tsx` - align fields, actions, loading, and inline result states.
- `apps/web/src/components/GraphModal.tsx` - align modal dimensions, focus behavior, and graph failure state.
- `apps/web/src/components/CaseLauncher.tsx` - align entry screen and Case controls with the design system.

---

### Task 1: Establish the Light Theme Contract

**Files:**
- Create: `apps/web/src/components/theme-contract.test.ts`
- Modify: `apps/web/src/styles/globals.css`
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: semantic CSS tokens `--background`, `--foreground`, `--card`, `--muted`, `--primary`, `--success`, `--warning`, `--destructive`, `--border`, `--border-subtle`, `--ring`, `--z-header`, `--z-drawer`, and `--z-modal`.
- Consumes: existing Tailwind v4 `@theme` mapping and legacy `app.css` variables.

- [ ] **Step 1: Write the failing theme contract test**

```ts
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
```

- [ ] **Step 2: Run the test and verify the current dark theme fails**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/theme-contract.test.ts`

Expected: FAIL because `globals.css` contains `color-scheme: dark` and the new semantic tokens do not exist.

- [ ] **Step 3: Replace the conflicting theme definitions**

Implement the shared token foundation in `globals.css` and map legacy aliases in `app.css`:

```css
@import "tailwindcss";

@theme {
  --color-background: #f2f4f5;
  --color-foreground: #17232d;
  --color-card: #ffffff;
  --color-card-foreground: #17232d;
  --color-popover: #ffffff;
  --color-popover-foreground: #17232d;
  --color-primary: #245b84;
  --color-primary-foreground: #ffffff;
  --color-secondary: #eef2f4;
  --color-secondary-foreground: #334552;
  --color-muted: #f7f8f9;
  --color-muted-foreground: #657582;
  --color-accent: #edf3f6;
  --color-accent-foreground: #1d4c70;
  --color-destructive: #b4232d;
  --color-destructive-foreground: #ffffff;
  --color-border: #d8dfe4;
  --color-input: #bdc8d0;
  --color-ring: #4e89b5;
  --radius: 0.4375rem;
}

@layer base {
  * { border-color: var(--border); }
  html { color-scheme: light; }
  body { background: var(--background); color: var(--foreground); }
}
```

Add `--success`, `--warning`, `--border-subtle`, the z-index scale, focus-visible styles, reduced-motion rules, and remove negative letter-spacing and layout-shifting button transforms from `app.css`.

- [ ] **Step 4: Run the theme contract and web build**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/theme-contract.test.ts`

Expected: PASS, 2 tests.

Run: `pnpm --filter @traceforge/web build`

Expected: Vite build exits 0.

- [ ] **Step 5: Commit the theme foundation**

```powershell
git add apps/web/src/styles/globals.css apps/web/src/app.css apps/web/src/components/theme-contract.test.ts
git commit -m "refactor(web): unify operations canvas theme"
```

---

### Task 2: Add the Responsive Workspace Coordinator

**Files:**
- Create: `apps/web/src/components/WorkspaceLayout.tsx`
- Create: `apps/web/src/components/WorkspaceLayout.test.ts`
- Modify: `apps/web/src/App.tsx`
- Modify: `apps/web/src/components/TopBar.tsx`
- Modify: `apps/web/src/components/TopBar.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: `WorkspacePanel = "traffic" | "agent" | "knowledge"`.
- Produces: `WorkspaceMode = "columns" | "drawer" | "single"`.
- Produces: `getWorkspaceMode(width: number): WorkspaceMode`.
- Produces: `WorkspaceLayout({ traffic, agent, knowledge }: WorkspaceLayoutProps)`.
- Consumes: existing `TrafficPanel`, `AgentPanel`, `KnowledgePanel`, and `TopBar`.

- [ ] **Step 1: Write failing viewport-mode tests**

```ts
import { describe, expect, it } from "vitest";
import { getWorkspaceMode } from "./WorkspaceLayout.js";

describe("getWorkspaceMode", () => {
  it.each([
    [1440, "columns"],
    [1100, "columns"],
    [1099, "drawer"],
    [768, "drawer"],
    [767, "single"],
    [375, "single"],
  ] as const)("maps %ipx to %s", (width, expected) => {
    expect(getWorkspaceMode(width)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and verify the module is missing**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/WorkspaceLayout.test.ts`

Expected: FAIL because `WorkspaceLayout.tsx` does not exist.

- [ ] **Step 3: Implement the coordinator and pure breakpoint contract**

```tsx
import { useEffect, useRef, useState, type ReactNode } from "react";

export type WorkspacePanel = "traffic" | "agent" | "knowledge";
export type WorkspaceMode = "columns" | "drawer" | "single";

export function getWorkspaceMode(width: number): WorkspaceMode {
  if (width >= 1100) return "columns";
  if (width >= 768) return "drawer";
  return "single";
}

export interface WorkspaceLayoutProps {
  traffic: ReactNode;
  agent: ReactNode;
  knowledge: ReactNode;
}

export function WorkspaceLayout({ traffic, agent, knowledge }: WorkspaceLayoutProps) {
  const [mode, setMode] = useState<WorkspaceMode>(() =>
    getWorkspaceMode(globalThis.innerWidth || 1440),
  );
  const [activePanel, setActivePanel] = useState<WorkspacePanel>("agent");
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);

  const closeDrawer = () => {
    setActivePanel("agent");
    requestAnimationFrame(() => lastTriggerRef.current?.focus());
  };

  useEffect(() => {
    const onResize = () => setMode(getWorkspaceMode(globalThis.innerWidth));
    globalThis.addEventListener("resize", onResize);
    return () => globalThis.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    if (mode === "columns") setActivePanel("agent");
  }, [mode]);

  useEffect(() => {
    if (mode !== "drawer" || activePanel === "agent") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [activePanel, mode]);

  return (
    <section className="workspace-shell" data-mode={mode} data-active-panel={activePanel}>
      <nav className="workspace-switcher" aria-label="Workbench panels">
        {(["traffic", "agent", "knowledge"] as const).map((panel) => (
          <button
            key={panel}
            type="button"
            aria-pressed={activePanel === panel}
            onClick={(event) => {
              lastTriggerRef.current = event.currentTarget;
              setActivePanel(panel);
            }}
          >
            {panel === "traffic" ? "Traffic" : panel === "agent" ? "Agent" : "Knowledge"}
          </button>
        ))}
      </nav>
      <div className="workspace-pane workspace-traffic">{traffic}</div>
      <div className="workspace-pane workspace-agent">{agent}</div>
      <div className="workspace-pane workspace-knowledge">{knowledge}</div>
      {mode === "drawer" && activePanel !== "agent" && (
        <button className="workspace-scrim" aria-label="Close side panel" onClick={closeDrawer} />
      )}
    </section>
  );
}
```

Wire it into `App.tsx`, give the global Toast `role="status"` and `aria-live="polite"`, then update `TopBar` to show the persisted Run status and Token totals from Zustand. Use CSS grid for columns, fixed overlay panes for drawer mode, and one visible pane for single mode.

- [ ] **Step 4: Run focused tests and build**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/WorkspaceLayout.test.ts apps/web/src/components/TopBar.test.ts`

Expected: PASS.

Run: `pnpm --filter @traceforge/web build`

Expected: exits 0 with no TypeScript or CSS errors.

- [ ] **Step 5: Commit the responsive shell**

```powershell
git add apps/web/src/App.tsx apps/web/src/app.css apps/web/src/components/WorkspaceLayout.tsx apps/web/src/components/WorkspaceLayout.test.ts apps/web/src/components/TopBar.tsx apps/web/src/components/TopBar.test.ts
git commit -m "feat(web): add responsive operations workspace"
```

---

### Task 3: Redesign Traffic as an Accessible Evidence Stream

**Files:**
- Modify: `apps/web/src/components/TrafficPanel.tsx`
- Modify: `apps/web/src/components/TrafficPanel.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: `trafficStatusTone(status: number | null | undefined): "success" | "redirect" | "warning" | "danger" | "unknown"`.
- Consumes: `TrafficEntry`, `BrowserControls`, `formatTrafficTime`, and existing Zustand Traffic state.

- [ ] **Step 1: Add failing status-tone tests**

```ts
import { describe, expect, it } from "vitest";
import { formatTrafficTime, trafficStatusTone } from "./TrafficPanel.js";

describe("trafficStatusTone", () => {
  it.each([
    [200, "success"],
    [302, "redirect"],
    [404, "warning"],
    [500, "danger"],
    [undefined, "unknown"],
  ] as const)("maps %s to %s", (status, expected) => {
    expect(trafficStatusTone(status)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing helper fails**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/TrafficPanel.test.ts`

Expected: FAIL because `trafficStatusTone` is not exported.

- [ ] **Step 3: Implement semantic request rows**

Add the pure helper:

```ts
export function trafficStatusTone(status: number | null | undefined) {
  if (status == null) return "unknown" as const;
  if (status >= 500) return "danger" as const;
  if (status >= 400) return "warning" as const;
  if (status >= 300) return "redirect" as const;
  if (status >= 200) return "success" as const;
  return "unknown" as const;
}
```

Replace clickable `<div>` headers with a full-width `<button>` using `aria-expanded` and `aria-controls`. Keep the complete URL available in the expanded area, render the status as text plus semantic class, and preserve request headers/body behavior.

- [ ] **Step 4: Run Traffic tests and build**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/TrafficPanel.test.ts`

Expected: PASS.

Run: `pnpm --filter @traceforge/web build`

Expected: exits 0.

- [ ] **Step 5: Commit Traffic redesign**

```powershell
git add apps/web/src/components/TrafficPanel.tsx apps/web/src/components/TrafficPanel.test.ts apps/web/src/app.css
git commit -m "refactor(web): redesign traffic evidence stream"
```

---

### Task 4: Extract Agent Conversation Presentation

**Files:**
- Create: `apps/web/src/components/agent/agent-conversation.ts`
- Create: `apps/web/src/components/agent/AgentEventRow.tsx`
- Modify: `apps/web/src/components/AgentPanel.tsx`
- Modify: `apps/web/src/components/AgentPanel.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: `AgentConversationItem` and `buildAgentConversationItems()` in `agent-conversation.ts`.
- Produces: `AgentEventRow({ item, expanded, onExpandedChange })`.
- Consumes: `AgentUiEvent` and existing event text from Zustand.

- [ ] **Step 1: Move conversation tests to the new module before moving code**

Update the test import:

```ts
import {
  type AgentConversationItem,
  buildAgentConversationItems,
} from "./agent/agent-conversation.js";
```

Retain the current duplicate suppression, noise filtering, tool compaction, Scope ordering, and label assertions without changing expected values.

- [ ] **Step 2: Run the test and verify the new module is missing**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/AgentPanel.test.ts`

Expected: FAIL because `agent/agent-conversation.ts` does not exist.

- [ ] **Step 3: Extract pure conversation construction**

Move `AgentConversationItem`, `isNoisyAgentEvent`, `formatAgentEvent`, `compactToolText`, and `buildAgentConversationItems` unchanged into `agent-conversation.ts`. Export only the type and builder used by tests and `AgentPanel`.

Implement `AgentEventRow` with this stable mapping:

```ts
export function agentEventTone(kind: AgentUiEvent["kind"]) {
  if (kind === "user") return "operator";
  if (kind === "error") return "error";
  if (kind === "reasoning") return "reasoning";
  if (kind === "tool_call" || kind === "tool_result") return "tool";
  return "agent";
}
```

Render Reasoning through the existing Radix Collapsible; render all other events as semantic `<article>` rows with an event label column and content column.

- [ ] **Step 4: Run Agent tests and TypeScript**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/AgentPanel.test.ts`

Expected: PASS with the existing conversation behavior intact.

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json`

Expected: exits 0.

- [ ] **Step 5: Commit the presentation extraction**

```powershell
git add apps/web/src/components/AgentPanel.tsx apps/web/src/components/AgentPanel.test.ts apps/web/src/components/agent/agent-conversation.ts apps/web/src/components/agent/AgentEventRow.tsx apps/web/src/app.css
git commit -m "refactor(web): split agent conversation presentation"
```

---

### Task 5: Make Agent Interventions and Run State Persistent

**Files:**
- Create: `apps/web/src/components/agent/AgentInterventionCard.tsx`
- Create: `apps/web/src/components/agent/AgentRunHeader.tsx`
- Modify: `apps/web/src/components/agent/agent-conversation.ts`
- Modify: `apps/web/src/components/AgentPanel.tsx`
- Modify: `apps/web/src/components/AgentPanel.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: `InterventionOutcome = { id: string; kind: "approval" | "scope"; decision: "approved" | "rejected" | "ignored" | "failed"; summary: string }`.
- Produces: `appendInterventionOutcome(outcomes, outcome): InterventionOutcome[]`.
- Produces: `AgentInterventionCard` with pending, submitting, resolved, and failed states.
- Produces: `AgentRunHeader` with Run status, elapsed state, Token usage, Clear, and Stop.
- Consumes: existing `resolveApproval`, `approveScope`, `interruptAgentRun`, `activeRun`, and `tokenUsage`.

- [ ] **Step 1: Write failing intervention lifecycle tests**

```ts
import { describe, expect, it } from "vitest";
import { appendInterventionOutcome } from "./agent/agent-conversation.js";

describe("appendInterventionOutcome", () => {
  it("keeps a resolved approval visible and replaces duplicate ids", () => {
    const approved = { id: "approval-1", kind: "approval", decision: "approved", summary: "exec_command approved" } as const;
    const failed = { ...approved, decision: "failed", summary: "Approval request failed" } as const;
    expect(appendInterventionOutcome([], approved)).toEqual([approved]);
    expect(appendInterventionOutcome([approved], failed)).toEqual([failed]);
  });
});
```

- [ ] **Step 2: Run the test and verify the lifecycle helper is missing**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/AgentPanel.test.ts`

Expected: FAIL because `appendInterventionOutcome` is not defined.

- [ ] **Step 3: Implement durable in-session intervention outcomes**

Add:

```ts
export interface InterventionOutcome {
  id: string;
  kind: "approval" | "scope";
  decision: "approved" | "rejected" | "ignored" | "failed";
  summary: string;
}

export function appendInterventionOutcome(
  outcomes: InterventionOutcome[],
  outcome: InterventionOutcome,
): InterventionOutcome[] {
  return [...outcomes.filter((item) => item.id !== outcome.id), outcome];
}
```

In `AgentPanel`, hold outcomes for the current Case, append the result before clearing a pending intervention, and render outcomes after the related pending item. On API failure, retain context and expose Retry rather than clearing the card.

Move the Run/Token/Clear/Stop UI to `AgentRunHeader`. Stop must show `Stopping...` while the request is in flight and `interrupting` when the backend reports that state.

- [ ] **Step 4: Run Agent tests and build**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/AgentPanel.test.ts`

Expected: PASS.

Run: `pnpm --filter @traceforge/web build`

Expected: exits 0.

- [ ] **Step 5: Commit intervention state improvements**

```powershell
git add apps/web/src/components/AgentPanel.tsx apps/web/src/components/AgentPanel.test.ts apps/web/src/components/agent/agent-conversation.ts apps/web/src/components/agent/AgentInterventionCard.tsx apps/web/src/components/agent/AgentRunHeader.tsx apps/web/src/app.css
git commit -m "feat(web): persist agent intervention outcomes"
```

---

### Task 6: Redesign Knowledge, Entry, Settings, and Graph Surfaces

**Files:**
- Create: `apps/web/src/components/PanelErrorBoundary.tsx`
- Create: `apps/web/src/components/KnowledgePanel.test.ts`
- Modify: `apps/web/src/components/KnowledgePanel.tsx`
- Modify: `apps/web/src/components/SettingsModal.tsx`
- Modify: `apps/web/src/components/GraphModal.tsx`
- Modify: `apps/web/src/components/CaseLauncher.tsx`
- Modify: `apps/web/src/components/TopBar.test.ts`
- Modify: `apps/web/src/components/SettingsModal.test.ts`
- Modify: `apps/web/src/app.css`

**Interfaces:**
- Produces: `PanelErrorBoundary({ name, children })` with an inline Retry action implemented by resetting the boundary key.
- Consumes: existing Knowledge tabs, Radix Tabs/Dialog, GraphView, LLM config actions, and Case APIs.

- [ ] **Step 1: Add failing source and rendering contracts**

Add assertions to existing tests:

```ts
it("renders settings as an accessible labelled form", () => {
  const source = readFileSync(new URL("./SettingsModal.tsx", import.meta.url), "utf8");
  expect(source).toContain("aria-live=\"polite\"");
  expect(source).toContain("Test connection");
});

it("keeps global status in the top bar", () => {
  const html = renderToString(createElement(TopBar));
  expect(html).toContain("TraceForge");
  expect(html).toContain("Settings");
});
```

Create a direct source contract for `KnowledgePanel.tsx` that expects `PanelErrorBoundary` to wrap each active Tab panel.

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("KnowledgePanel failure isolation", () => {
  it("wraps tab content in a local error boundary", () => {
    const source = readFileSync(new URL("./KnowledgePanel.tsx", import.meta.url), "utf8");
    expect(source).toContain("PanelErrorBoundary");
    expect(source).toContain("name={TAB_TITLE[activeTab]}");
  });
});
```

- [ ] **Step 2: Run focused tests and verify missing contracts fail**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src/components/TopBar.test.ts apps/web/src/components/SettingsModal.test.ts apps/web/src/components/KnowledgePanel.test.ts`

Expected: FAIL on the new accessible result and error-boundary requirements.

- [ ] **Step 3: Implement the remaining approved surfaces**

Implement `PanelErrorBoundary` as a class error boundary because React 18 has no hook equivalent:

```tsx
export class PanelErrorBoundary extends React.Component<
  { name: string; children: React.ReactNode },
  { error: Error | null; retryKey: number }
> {
  state: { error: Error | null; retryKey: number } = { error: null, retryKey: 0 };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div className="panel-error" role="alert">
          <strong>{this.props.name} could not be displayed.</strong>
          <span>{this.state.error.message}</span>
          <button type="button" onClick={() => this.setState(({ retryKey }) => ({ error: null, retryKey: retryKey + 1 }))}>Retry</button>
        </div>
      );
    }
    return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
  }
}
```

Use dense underline Tabs in Knowledge, preserve all six destinations, and isolate each active panel. Update Settings to grouped labelled fields, place test status in `aria-live="polite"`, preserve manual Base URL behavior, and keep the API key behavior unchanged. Update Graph Modal and Case Launcher to use the same tokens, radii, focus states, and responsive constraints.

- [ ] **Step 4: Run all web tests and build**

Run: `.\node_modules\.bin\vitest.CMD run apps/web/src`

Expected: all web tests PASS.

Run: `pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json`

Expected: exits 0.

Run: `pnpm --filter @traceforge/web build`

Expected: exits 0.

- [ ] **Step 5: Commit the remaining surfaces**

```powershell
git add apps/web/src/components/PanelErrorBoundary.tsx apps/web/src/components/KnowledgePanel.tsx apps/web/src/components/KnowledgePanel.test.ts apps/web/src/components/SettingsModal.tsx apps/web/src/components/SettingsModal.test.ts apps/web/src/components/GraphModal.tsx apps/web/src/components/CaseLauncher.tsx apps/web/src/components/TopBar.test.ts apps/web/src/app.css
git commit -m "refactor(web): align knowledge and modal surfaces"
```

---

### Task 7: Verify the Complete Product with Real Services

**Files:**
- Modify only files required by defects found during verification.
- Do not add screenshots, temporary Case data, API keys, or visual companion files to Git.

**Interfaces:**
- Consumes: real TraceForge server, real configured LLM, actual Case state, shared browser, and all implemented UI components.
- Produces: verified Operations Canvas across the required viewports.

- [ ] **Step 1: Run the complete static and unit verification set**

Run:

```powershell
.\node_modules\.bin\vitest.CMD run apps/web/src
pnpm --filter @traceforge/web exec tsc --noEmit -p tsconfig.json
pnpm --filter @traceforge/server exec tsc --noEmit -p tsconfig.json
pnpm --filter @traceforge/web build
git diff --check
```

Expected: every command exits 0; Vitest reports zero failed tests.

- [ ] **Step 2: Start real server and web development processes**

Run the server and Vite using hidden Windows processes, selecting unused ports if defaults are occupied:

```powershell
Start-Process -WindowStyle Hidden -FilePath "pnpm.cmd" -ArgumentList "dev:server" -WorkingDirectory "E:\learn\TraceForge"
Start-Process -WindowStyle Hidden -FilePath "pnpm.cmd" -ArgumentList "dev:web","--","--host","127.0.0.1" -WorkingDirectory "E:\learn\TraceForge"
```

Expected: server health/API responds and Vite serves the web application.

- [ ] **Step 3: Validate real Case restoration before starting a new Run**

Open an existing Case and verify Traffic, Facts, Tasks, Timeline, MCP, Graph, Observer, active/latest Run, and persisted Token values load from the server. Refresh once and confirm Token values remain backend-derived rather than being recalculated by the client.

- [ ] **Step 4: Validate the real LLM Run workflow**

Use the configured real Provider and model to send one bounded instruction against an authorized local test target. Verify streaming text, Reasoning folding, tool call/result rows, Approval, Scope, Steering, Stop, completion, Token updates, and Observer handling. No mock provider or fabricated event injection is allowed.

- [ ] **Step 5: Capture and inspect required viewports**

Use browser automation to inspect and capture:

- 1440x900
- 1280x720
- 1024x768
- 768x1024
- 375x812

At every viewport verify no blank panels, overlap, incoherent horizontal scroll, clipped buttons, hidden Composer, unreadable long URL/command, or inaccessible Drawer/Tab state. Also verify keyboard focus, Escape dismissal, and reduced-motion behavior.

- [ ] **Step 6: Fix each observed defect with a focused regression test**

For every defect, add the smallest failing test to the owning component test file, run it to observe failure, apply one scoped fix, rerun the focused test, then rerun the full Task 7 Step 1 command set.

- [ ] **Step 7: Commit verified corrections**

```powershell
git add apps/web/src
git commit -m "fix(web): resolve operations canvas verification defects"
```

Skip this commit when verification produces no code changes.

---

## Final Acceptance Checklist

- [ ] Operations Canvas matches the approved high-fidelity B sample.
- [ ] Existing product features remain available and interactive.
- [ ] Light CSS tokens are the only active theme source.
- [ ] Approval, Scope, Observer, Stop, and failure outcomes remain visible after action.
- [ ] Refresh restores backend Token values without client recalculation.
- [ ] All LLM-triggering validation used the real configured LLM.
- [ ] Web and server TypeScript checks pass.
- [ ] All web Vitest tests pass.
- [ ] Production web build passes.
- [ ] `git diff --check` passes.
- [ ] Required viewport screenshots show no overlap, blank content, or clipping.
