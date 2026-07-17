// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyTheme, getStoredTheme, persistTheme, THEME_CHANGE_EVENT, THEME_STORAGE_KEY } from "./theme.js";

describe("app theme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.classList.remove("dark");
  });

  it("defaults to dark and restores a saved light preference", () => {
    expect(getStoredTheme()).toBe("dark");
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    expect(getStoredTheme()).toBe("light");
  });

  it("applies and persists the selected theme", () => {
    let themeChangeCount = 0;
    const onThemeChange = () => { themeChangeCount += 1; };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange, { once: true });
    persistTheme("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(themeChangeCount).toBe(1);

    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
