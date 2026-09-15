type Journal = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** Desktop origin changes on restart. The native journal is independent of its port. */
export function desktopJournalStorage(): Journal {
  const desktop = (window as Window & { traceforgeDesktop?: { mode?: string; localState?: Journal } }).traceforgeDesktop;
  if (desktop?.mode === "workbench") {
    if (!desktop.localState) throw new Error("Desktop journal is unavailable");
    return desktop.localState;
  }
  return window.localStorage; // Standalone renderer preview and tests only.
}
