import { useStore } from "../store.js";
import { GraphView } from "./GraphView.js";

export function GraphModal() {
  const { graphModalOpen, setGraphModalOpen } = useStore();
  if (!graphModalOpen) return null;
  return (
    <div className="tf-modal-bg" onClick={() => setGraphModalOpen(false)}>
      <div className="tf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header" style={{ justifyContent: "space-between" }}>
          <h2>证据关系图谱</h2>
          <button className="tf-btn" onClick={() => setGraphModalOpen(false)}>关闭</button>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}><GraphView interactive /></div>
      </div>
    </div>
  );
}
