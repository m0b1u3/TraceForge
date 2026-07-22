import { useEffect, useRef, useState, type ReactNode } from "react";
import { X } from "@phosphor-icons/react";
import { useStore } from "../store.js";

export type WorkspacePanel = "traffic" | "agent" | "knowledge";
export type WorkspaceMode = "columns" | "drawer" | "single";

export interface WorkspaceLayoutProps {
  traffic: ReactNode;
  agent: ReactNode;
  knowledge: ReactNode;
}

const PANELS: readonly WorkspacePanel[] = ["traffic", "agent", "knowledge"];

function panelLabel(panel: WorkspacePanel): string {
  if (panel === "traffic") return "Traffic";
  if (panel === "agent") return "Agent";
  return "Knowledge";
}

export function getWorkspaceMode(width: number): WorkspaceMode {
  if (width >= 1100) return "columns";
  if (width >= 768) return "drawer";
  return "single";
}

export function WorkspaceLayout({ traffic, agent, knowledge }: WorkspaceLayoutProps) {
  const [mode, setMode] = useState<WorkspaceMode>(() => getWorkspaceMode(globalThis.innerWidth || 1440));
  const [activePanel, setActivePanel] = useState<WorkspacePanel>("agent");
  const panelRequest = useStore((state) => state.workspacePanelRequest);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const handledRequestRef = useRef(0);
  const trafficPaneRef = useRef<HTMLDivElement | null>(null);
  const knowledgePaneRef = useRef<HTMLDivElement | null>(null);

  const closeDrawer = () => {
    setActivePanel("agent");
    lastTriggerRef.current?.focus();
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
    if (!panelRequest || panelRequest.requestId === handledRequestRef.current) return;
    handledRequestRef.current = panelRequest.requestId;
    if (mode === "columns") return;
    lastTriggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setActivePanel(panelRequest.panel);
  }, [mode, panelRequest]);

  useEffect(() => {
    if (mode === "columns" || activePanel === "agent") return;
    const pane = activePanel === "traffic" ? trafficPaneRef.current : knowledgePaneRef.current;
    const firstControl = pane?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]');
    (firstControl ?? pane)?.focus();
    if (mode !== "drawer") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeDrawer();
    };
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [activePanel, mode]);

  return (
    <section className="workspace-shell" data-mode={mode} data-active-panel={activePanel}>
      <nav className="workspace-switcher" aria-label="Workbench panels">
        {PANELS.map((panel) => (
          <button
            key={panel}
            type="button"
            value={panel}
            aria-pressed={activePanel === panel}
            aria-controls={`workspace-${panel}`}
            onClick={(event) => {
              lastTriggerRef.current = event.currentTarget;
              setActivePanel(panel);
            }}
          >
            {panelLabel(panel)}
          </button>
        ))}
      </nav>
      <div ref={trafficPaneRef} className="workspace-pane workspace-traffic" id="workspace-traffic" role={mode === "drawer" && activePanel === "traffic" ? "dialog" : undefined} aria-modal={mode === "drawer" && activePanel === "traffic" ? true : undefined} aria-label={mode === "drawer" && activePanel === "traffic" ? "Traffic panel" : undefined} tabIndex={mode === "drawer" && activePanel === "traffic" ? -1 : undefined}>
        {mode === "drawer" && activePanel === "traffic" && <button type="button" className="workspace-drawer-close" aria-label="Close Traffic panel" onClick={closeDrawer}><X size={15} /></button>}
        {traffic}
      </div>
      <div className="workspace-pane workspace-agent" id="workspace-agent">{agent}</div>
      <div ref={knowledgePaneRef} className="workspace-pane workspace-knowledge" id="workspace-knowledge" role={mode === "drawer" && activePanel === "knowledge" ? "dialog" : undefined} aria-modal={mode === "drawer" && activePanel === "knowledge" ? true : undefined} aria-label={mode === "drawer" && activePanel === "knowledge" ? "Knowledge panel" : undefined} tabIndex={mode === "drawer" && activePanel === "knowledge" ? -1 : undefined}>
        {mode === "drawer" && activePanel === "knowledge" && <button type="button" className="workspace-drawer-close" aria-label="Close Knowledge panel" onClick={closeDrawer}><X size={15} /></button>}
        {knowledge}
      </div>
      {mode === "drawer" && activePanel !== "agent" && (
        <button className="workspace-scrim" type="button" aria-label="Close side panel" onClick={closeDrawer} />
      )}
    </section>
  );
}
