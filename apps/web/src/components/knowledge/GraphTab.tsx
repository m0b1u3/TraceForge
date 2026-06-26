import { useStore } from "../../store.js";
import { GraphView } from "../GraphView.js";

export function GraphTab() {
  const setGraphModalOpen = useStore((s) => s.setGraphModalOpen);
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 6 }}>
        <button className="tf-btn" onClick={() => setGraphModalOpen(true)}>放大</button>
      </div>
      <div style={{ flex: 1, minHeight: 240, border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
        <GraphView interactive={false} />
      </div>
    </div>
  );
}
