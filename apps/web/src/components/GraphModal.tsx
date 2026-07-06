import { useStore } from "../store.js";
import { GraphView } from "./GraphView.js";

export function GraphModal() {
  const { graphModalOpen, setGraphModalOpen } = useStore();
  if (!graphModalOpen) return null;
  return (
    <div className="tf-modal-bg" onClick={() => setGraphModalOpen(false)}>
      <div className="tf-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header graph-modal-header">
          <h2>Evidence graph</h2>
          <button className="tf-btn" onClick={() => setGraphModalOpen(false)}>Close</button>
        </div>
        <div className="graph-modal-body"><GraphView interactive /></div>
      </div>
    </div>
  );
}
