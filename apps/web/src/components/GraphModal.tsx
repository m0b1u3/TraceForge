import { useStore } from "../store.js";
import { GraphView } from "./GraphView.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { useShallow } from "zustand/react/shallow";

export function GraphModal() {
  const { graphModalOpen, setGraphModalOpen } = useStore(useShallow((state) => ({ graphModalOpen: state.graphModalOpen, setGraphModalOpen: state.setGraphModalOpen })));
  return (
    <Dialog open={graphModalOpen} onOpenChange={setGraphModalOpen}>
      <DialogContent className="graph-modal-dialog" aria-describedby="graph-modal-description">
        <DialogHeader className="panel-header graph-modal-header">
          <DialogTitle>Reasoning chain</DialogTitle>
          <DialogDescription className="sr-only" id="graph-modal-description">Replay the Agent timeline and inspect linked evidence.</DialogDescription>
        </DialogHeader>
        <div className="graph-modal-body"><GraphView interactive /></div>
      </DialogContent>
    </Dialog>
  );
}
