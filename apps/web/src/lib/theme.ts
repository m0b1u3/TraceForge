export type AppTheme = "dark" | "light";

export const THEME_STORAGE_KEY = "traceforge:theme";

export function getStoredTheme(storage: Pick<Storage, "getItem"> | null = globalThis.localStorage ?? null): AppTheme {
  return storage?.getItem(THEME_STORAGE_KEY) === "light" ? "light" : "dark";
}

export function applyTheme(theme: AppTheme, root: HTMLElement = document.documentElement): void {
  root.dataset.theme = theme;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
}

export function persistTheme(theme: AppTheme, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme);
}
