import { useCallback, useSyncExternalStore } from "react";
import { getStoredTheme, persistTheme, THEME_CHANGE_EVENT, type AppTheme } from "../lib/theme.js";

function subscribe(listener: () => void): () => void {
  globalThis.addEventListener(THEME_CHANGE_EVENT, listener);
  globalThis.addEventListener("storage", listener);
  return () => {
    globalThis.removeEventListener(THEME_CHANGE_EVENT, listener);
    globalThis.removeEventListener("storage", listener);
  };
}

function getSnapshot(): AppTheme {
  const applied = document.documentElement.dataset.theme;
  return applied === "light" || applied === "dark" ? applied : getStoredTheme();
}

export function useAppTheme(): { theme: AppTheme; setTheme: (theme: AppTheme) => void; toggleTheme: () => void } {
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => "dark");
  const setTheme = useCallback((nextTheme: AppTheme) => persistTheme(nextTheme), []);
  const toggleTheme = useCallback(() => persistTheme(theme === "dark" ? "light" : "dark"), [theme]);
  return { theme, setTheme, toggleTheme };
}
