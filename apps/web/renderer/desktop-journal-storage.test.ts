// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { desktopJournalStorage } from "./desktop-journal-storage";
afterEach(() => { delete (window as any).traceforgeDesktop; });
it("uses the native journal for real desktop sessions and refuses a missing bridge", () => {
  const journal = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() };
  (window as any).traceforgeDesktop = { mode: "workbench", localState: journal };
  expect(desktopJournalStorage()).toBe(journal);
  delete (window as any).traceforgeDesktop.localState; expect(() => desktopJournalStorage()).toThrow();
});
it("retains standalone preview storage without installing a fake native bridge", () => expect(desktopJournalStorage()).toBe(window.localStorage));
