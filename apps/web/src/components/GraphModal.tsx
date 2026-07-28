import { useStore } from "../store.js";
import { AttackPathView } from "./AttackPathView.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { useShallow } from "zustand/react/shallow";
import { GitBranch } from "@phosphor-icons/react";

export function GraphModal() {
  const { graphModalOpen, setGraphModalOpen } = useStore(useShallow((state) => ({ graphModalOpen: state.graphModalOpen, setGraphModalOpen: state.setGraphModalOpen })));
  return (
    <Dialog open={graphModalOpen} onOpenChange={setGraphModalOpen}>
      <DialogContent className="graph-modal-dialog" aria-describedby="graph-modal-description">
        <DialogHeader className="panel-header graph-modal-header">
          <span className="graph-modal-heading-icon" aria-hidden="true"><GitBranch size={17} weight="duotone" /></span>
          <div>
            <DialogTitle>Attack paths</DialogTitle>
            <DialogDescription id="graph-modal-description">Evidence-backed investigation routes and validation state.</DialogDescription>
          </div>
        </DialogHeader>
        <div className="graph-modal-body"><AttackPathView /></div>
      </DialogContent>
    </Dialog>
  );
}
