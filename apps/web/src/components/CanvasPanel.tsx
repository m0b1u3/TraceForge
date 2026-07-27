import { GitBranch } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { useStore } from "../store.js";
import { GraphView } from "./GraphView.js";

export function CanvasPanel() {
  const setGraphModalOpen = useStore((state) => state.setGraphModalOpen);
  return (
    <div className="canvas-panel">
      <GraphView interactive />
      <div className="canvas-panel-actions">
        <Button type="button" variant="outline" size="sm" onClick={() => setGraphModalOpen(true)}>
          <GitBranch size={14} /> Paths
        </Button>
      </div>
    </div>
  );
}
