import { useStore } from "../store.js";
import { AttackPathView } from "./AttackPathView.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog.js";
import { useShallow } from "zustand/react/shallow";

export function GraphModal() {
  const { graphModalOpen, setGraphModalOpen } = useStore(useShallow((state) => ({ graphModalOpen: state.graphModalOpen, setGraphModalOpen: state.setGraphModalOpen })));
  return (
    <Dialog open={graphModalOpen} onOpenChange={setGraphModalOpen}>
      <DialogContent className="graph-modal-dialog" aria-describedby="graph-modal-description">
        <DialogHeader className="panel-header graph-modal-header">
          <DialogTitle>Attack paths</DialogTitle>
          <DialogDescription className="sr-only" id="graph-modal-description">Inspect persistent attack paths, step validation, identities, and linked evidence.</DialogDescription>
        </DialogHeader>
        <div className="graph-modal-body"><AttackPathView /></div>
      </DialogContent>
    </Dialog>
  );
}
