# TraceForge Frontend UI Optimization Design

> Date: 2026-07-03  
> Target style: Linear / Vercel — minimal light theme, generous whitespace, soft shadows, clear hierarchy, engineer-tool restraint.  
> Constraint: keep React + Vite + CSS stack, do not overturn existing architecture.

## 1. Goal

The current workbench UI has rough edges left over from rapid iteration: inconsistent spacing, mixed inline styles, hard borders, generic "AI product" aesthetics. This design upgrades the visual system to feel like a polished developer/security tool rather than a chatbot dashboard.

## 2. Guiding Principles

- **Restraint over decoration.** No gradients, no oversized illustrations, no glowing accents.
- **Hierarchy through spacing and type.** Less reliance on color to communicate structure.
- **Consistency.** One spacing grid, one radius scale, one set of component primitives.
- **Clarity of state.** Run status, pending approvals, warnings are immediately readable.
- **No AI sheen.** Avoid chatbot clichés: bubbly avatars, multi-color confetti states, explanatory filler text.

## 3. Token Redefinition

### 3.1 Typography

Match Vercel's Geist Sans crispness. Use only standard font weights (400/500/600/700) to avoid synthetic bolding. Keep Chinese fallback lightweight so it does not dominate the Latin texture.

```css
:root {
  --font: "Geist Sans", "Noto Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SFMono-Regular", "Cascadia Mono", Consolas, monospace;

  --font-regular: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;
}

body {
  font-family: var(--font);
  font-weight: var(--font-regular);
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
```

Type scale:

| Token | Size | Line height | Weight | Letter spacing | Use |
|---|---|---|---|---|---|
| `--text-hero` | 40px | 1.1 | 600 | -0.03em | Onboarding title |
| `--text-title` | 18px | 1.25 | 600 | -0.02em | Modal titles, section headers |
| `--text-heading` | 14px | 1.35 | 600 | -0.01em | Panel titles |
| `--text-body` | 13px | 1.55 | 400 | 0 | Body, messages, rows |
| `--text-small` | 12px | 1.45 | 500 | 0 | Badges, pills, timestamps |
| `--text-micro` | 11px | 1.35 | 600 | 0.02em | Kicker/label |
| `--text-mono` | 12px | 1.45 | 400 | 0 | URLs, IDs, code |

Rules:

- **No custom weights** like 650/720/760/820. Use 400/500/600/700 only.
- **Negative letter-spacing on headings** for tighter, Vercel-like display type.
- **Noto Sans SC** used only for CJK fallback; keep it at normal weight so Chinese characters sit cleanly next to Geist's Latin glyphs.
- **Line height is tighter** than the current loose 1.65–1.75, especially for labels and panel titles.

### 3.2 Color

```css
:root {
  --bg: #fafafa;
  --panel: #ffffff;
  --panel-elevated: #ffffff;
  --panel-soft: #f7f8fa;

  --line: #eceeef;
  --line-strong: #dfe1e4;
  --line-focus: #2563eb;

  --text: #111827;
  --text-secondary: #4b5563;
  --text-tertiary: #9ca3af;

  --accent: #2563eb;
  --accent-soft: #eff4ff;
  --amber: #b45309;
  --amber-soft: #fff7ed;
  --green: #047857;
  --green-soft: #ecfdf5;
  --red: #dc2626;
  --red-soft: #fef2f2;
}
```

### 3.3 Shadow

```css
--shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
--shadow: 0 4px 12px rgba(0, 0, 0, 0.05);
--shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.08);
```

### 3.4 Radius

```css
--radius-sm: 8px;
--radius: 12px;
--radius-lg: 16px;
--radius-xl: 20px;
--radius-full: 999px;
```

### 3.5 Spacing
Strict 4px grid, exposed as CSS variables:

```css
--space-1: 4px;
--space-2: 8px;
--space-3: 12px;
--space-4: 16px;
--space-5: 20px;
--space-6: 24px;
```

## 4. Component Primitives

All primitives use the typography tokens above. Headings use `-0.01em` to `-0.03em` letter-spacing; body text uses `0`.

### 4.1 Buttons

All buttons 34px height, 10px radius, 13px semibold text.

| Variant | Class | Style |
|---|---|---|
| Primary | `.tf-btn.tf-btn-primary` | accent fill, white text |
| Secondary | `.tf-btn` | white fill, strong border |
| Danger | `.tf-btn.tf-btn-danger` | red-soft fill, red border/text |
| Ghost | `.tf-btn.tf-btn-ghost` | transparent, secondary text |

### 4.2 Inputs

- Height 34px, radius 10px, border `--line-strong`.
- Focus: `border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.12);`.
- No outer glow on idle.

### 4.3 Pills / Badges

Pills are 26px height, 999px radius, used for status and counts.

```css
.tf-pill { background: var(--panel-soft); border: 1px solid var(--line); color: var(--text-secondary); }
.tf-pill-accent { background: var(--accent-soft); border-color: #dbeafe; color: var(--accent); }
.tf-pill-amber { background: var(--amber-soft); border-color: #fed7aa; color: var(--amber); }
.tf-pill-green { background: var(--green-soft); border-color: #a7f3d0; color: var(--green); }
.tf-pill-red { background: var(--red-soft); border-color: #fecaca; color: var(--red); }
```

### 4.4 Segmented Tabs

Replace the current tab button row with a contained segmented control:

```css
.tf-tabs {
  display: inline-flex;
  gap: var(--space-1);
  padding: var(--space-1);
  background: var(--panel-soft);
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
}
.tf-tab {
  padding: 6px 12px;
  border-radius: var(--space-2);
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  background: transparent;
  border: 0;
}
.tf-tab.active {
  background: var(--panel);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}
```

### 4.5 List Rows

```css
.tf-row {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--line);
  font-size: 13px;
  line-height: 1.5;
  color: var(--text);
}
.tf-row:last-child { border-bottom: none; }
.tf-row:hover { background: var(--panel-soft); }
```

## 5. Layout

### 5.1 TopBar

Reduce visual weight. Only three items:

- Brand logo + name
- Case selector (bar variant)
- Control pill (`llm` / `human`)

Stats move to panel headers. Browser URL moves to Traffic panel header.

### 5.2 Workspace Grid

```css
.workspace {
  display: grid;
  grid-template-columns: 300px minmax(400px, 1fr) minmax(380px, 40vw);
  gap: var(--space-4);
  padding: var(--space-4);
}
```

### 5.3 Panel Shell

```css
.panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  background: var(--panel);
  box-shadow: var(--shadow);
}
```

### 5.4 Unified Panel Header

```tsx
<header className="panel-header">
  <div className="panel-header-main">
    <Icon size={18} />
    <div>
      <span className="section-kicker">{subtitle}</span>
      <h2>{title}</h2>
    </div>
  </div>
  <div className="panel-header-actions">
    {countPill}
    {primaryAction}
  </div>
</header>
```

```css
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 52px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}
.panel-header-main { display: flex; align-items: center; gap: var(--space-3); }
.panel-header-main h2 { font-size: 14px; font-weight: 650; color: var(--text); margin: 0; }
.section-kicker { font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-tertiary); }
```

## 6. Agent Panel

### 6.1 Messages

Remove dashed tool borders. Distinguish types through subtle background and alignment:

```css
.message {
  max-width: 86%;
  padding: 10px 12px;
  border-radius: var(--radius);
  font-size: 13px;
  line-height: 1.5;
}
.message.agent { background: var(--panel-soft); border: 1px solid var(--line); }
.message.operator { margin-left: auto; background: var(--accent-soft); }
.message.tool { font-family: var(--mono); font-size: 12px; background: var(--panel); border: 1px solid var(--line); color: var(--text-secondary); }
.message.trace { border-left: 3px solid var(--amber); background: var(--panel); }
```

Hide repeated labels in the stream; only show a small uppercase label on the first occurrence of a new type, or rely on background difference alone.

### 6.2 Composer

Convert from floating shadow box to a clean bottom bar attached to the panel:

```css
.composer {
  display: flex;
  align-items: flex-end;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--line);
  background: var(--panel);
}
.composer textarea {
  flex: 1;
  min-height: 38px;
  max-height: 120px;
  padding: 9px 12px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-sm);
  font-size: 13px;
  resize: none;
  background: var(--panel);
}
.composer textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(37,99,235,0.12); }
```

- Send button: `.tf-btn-primary` with paper-plane icon.
- Stop button: `.tf-btn-danger` with square icon, only shown during active run.

### 6.3 Confirmation Cards

Limit width and center in the stream:

```css
.tf-confirm {
  width: min(100%, 480px);
  margin: 0 auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  padding: var(--space-4);
  background: var(--panel);
  box-shadow: var(--shadow);
}
.tf-confirm-warn { border-color: #fed7aa; background: var(--amber-soft); }
.tf-confirm-info { border-color: #dbeafe; background: var(--accent-soft); }
```

Actions always left-aligned with primary action first, reject/dismiss second, ghost ignore last.

### 6.4 Empty State

Replace generic sparkle with context-specific icon and tight copy:

```tsx
<div className="tf-guide">
  <Sparkle size={20} />
  <div className="tf-guide-title">Agent is idle</div>
  <div className="tf-guide-hint">Give it a target, e.g. “test example.com/login for IDOR.”</div>
</div>
```

No exclamation marks, no marketing copy.

## 7. Traffic Panel

### 7.1 Header

Move browser URL and control state here:

```tsx
<header className="panel-header">
  <div className="panel-header-main">
    <Globe size={18} />
    <div>
      <span className="section-kicker">Capture</span>
      <h2>Traffic</h2>
    </div>
  </div>
  <div className="panel-header-actions">
    <span className="tf-pill">{requestCount} req</span>
    <button className="tf-btn-ghost">Clear</button>
  </div>
</header>
```

### 7.2 Browser Strip

Simplify to one row: status dot + URL + control pill.

```css
.browser-strip {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--line);
  background: var(--panel-soft);
  font-size: 12px;
  color: var(--text-secondary);
}
```

### 7.3 Request Rows

Keep method badge, but soften row:

```css
.request-row {
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  margin: 0 var(--space-3) var(--space-2);
  background: var(--panel);
  border: 1px solid transparent;
}
.request-row:hover { background: var(--panel-soft); border-color: var(--line); }
.request-row.is-open { background: var(--panel-soft); border-color: var(--line-strong); }
```

## 8. Knowledge Panel

### 8.1 Tabs

Use the segmented control from §4.4. Active tab gets a white pill background with subtle shadow.

### 8.2 FactsTab

- Rows follow `.tf-row`.
- Type badge uses `.tf-pill-accent` or muted variant.
- Expand detail uses `pre` with `max-height: 200px`, subtle scrollbar.
- Confidence and timestamps as inline secondary text, not separate badges.

### 8.3 TasksTab

Add explicit status classes:

```css
.tf-status-open { color: var(--text-secondary); background: var(--panel-soft); }
.tf-status-blocked { color: var(--amber); background: var(--amber-soft); }
.tf-status-done { color: var(--green); background: var(--green-soft); }
.tf-status-recheck { color: var(--accent); background: var(--accent-soft); }
```

Priority stays as `.tf-prio-*`.

### 8.4 TimelineTab

Give it visual structure: left connector line + timestamp + event tag + detail.

```css
.timeline-item {
  position: relative;
  padding-left: 20px;
  padding-bottom: var(--space-4);
  border-left: 1px solid var(--line);
}
.timeline-item::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 2px;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--line-strong);
}
.timeline-time { font-size: 11px; color: var(--text-tertiary); }
```

### 8.5 ObserverTab

Warning rows use `.tf-row` + left border color by level:

```css
.observer-row.critical { border-left: 3px solid var(--red); }
.observer-row.warning { border-left: 3px solid var(--amber); }
.observer-row.info { border-left: 3px solid var(--accent); }
```

Open warnings show action row with primary, secondary, ghost buttons. Resolved warnings show a muted status pill.

### 8.6 GraphTab

- Embedded graph canvas: `min-height: 240px`, `background: var(--panel-soft)`.
- "Expand" button sits inside panel header actions, not floating at the bottom.
- Detail panel slides in from right with `transform` transition.
- Increase ELK `spacing.nodeNode` from 80 to 110 to reduce overlap.
- Hide edge labels when zoom < 0.65.

## 9. Onboarding (CaseLauncher)

Clean up the split-hero page:

- Left title block: 44px → 40px, tighter line-height.
- Right launcher card: white, 16px radius, no floating shadow on the whole hero.
- Inputs use new input style.
- Feature pills removed or reduced to one line.

## 10. Micro-interactions

- All interactive elements: `transition: all 120ms ease`.
- Buttons: `:active { transform: translateY(1px); }`.
- Panels: no hover lift; rely on content hover states.
- Toast: slide-up 180ms, keep current red style but align radius/shadow.
- Graph detail panel: `transform: translateX(100%)` → `translateX(0)` over 200ms ease.

## 11. Responsive

At `max-width: 1120px`, collapse to single column with each panel as a card. Keep `min-height` reasonable (360–420px) but use flex, not hard heights. Ensure segmented tabs scroll horizontally if needed.

At `max-width: 560px`, stack all panel-header actions and composer controls.

## 12. Implementation Notes

- No new dependencies. Keep `@phosphor-icons/react` and `@xyflow/react`.
- Replace inline `style={{ ... }}` in knowledge tabs and launcher with CSS classes.
- Delete obsolete CSS rules instead of overriding them.
- Add token variables at the top of `app.css`; migrate component classes in place.
- Tests: ensure `AgentPanel.test.ts`, `ObserverTab.test.ts`, `TopBar.test.ts` still pass after class name changes.

## 13. Success Criteria

- `pnpm test` still passes all 316 tests.
- `pnpm -r build` succeeds.
- No inline `style` remains in `AgentPanel.tsx`, `KnowledgePanel.tsx`, knowledge tabs, `CaseLauncher.tsx`, or `TopBar.tsx` except for dynamic values (e.g. graph transform).
- UI no longer uses dashed tool borders, generic sparkle empty states, or bright inline warning colors.
- A user can glance at any panel and immediately know its state and available actions.
