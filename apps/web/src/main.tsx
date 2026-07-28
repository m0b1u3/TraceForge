import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import { App } from "./App.js";
import { applyTheme, getStoredTheme } from "./lib/theme.js";
import "./styles/globals.css";
import "./styles/primitives.css";
import "./styles/workbench.css";
import "./styles/overlays.css";
import "./styles/motion.css";

applyTheme(getStoredTheme());
createRoot(document.getElementById("root")!).render(<App />);
