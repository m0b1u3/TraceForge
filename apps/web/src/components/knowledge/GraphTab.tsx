import { useStore } from "../../store.js";
import { GraphView } from "../GraphView.js";

export function GraphTab() {
  return (
    <GraphView interactive={false} />
  );
}
