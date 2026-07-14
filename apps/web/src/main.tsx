import { createRoot } from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";
import { App } from "./App.js";
import { applyTheme, getStoredTheme } from "./lib/theme.js";
import "./app.css";
import "./styles/globals.css";
import "./styles/dark-workbench.css";

applyTheme(getStoredTheme());
createRoot(document.getElementById("root")!).render(<App />);
