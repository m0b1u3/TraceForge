import { useStore } from "../../store.js";
import { GraphView } from "../GraphView.js";

export function GraphTab() {
  return (
    <div className="knowledge-graph"><GraphView interactive={false} /></div>
  );
}
