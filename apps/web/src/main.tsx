import { createRoot } from "react-dom/client";
import "./styles/fonts.css";
import { App } from "./App.js";
import { applyTheme, getStoredTheme } from "./lib/theme.js";
import "./app.css";
import "./styles/globals.css";
import "./styles/dark-workbench.css";
import "./styles/production-ui.css";

applyTheme(getStoredTheme());
createRoot(document.getElementById("root")!).render(<App />);
