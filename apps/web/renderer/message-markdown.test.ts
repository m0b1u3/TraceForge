// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { MessageMarkdown } from "./message-markdown";

it("renders structured replies without executing HTML, loading images or unsafe links", async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement("div"), root = createRoot(node);
  try {
    await act(async () => root.render(React.createElement(MessageMarkdown, {text:'## Result\n\n- First\n- Second\n\n```sh\necho example\n```\n\n| Column | Value |\n| --- | --- |\n| A | B |\n\n![Remote](https://example.com/image.png)\n\n[Unsafe](javascript:alert(1))\n\n<script>alert(1)</script>'})));
    expect(node.querySelector("h2")?.textContent).toBe("Result");
    expect(node.querySelectorAll("li")).toHaveLength(2);
    expect(node.querySelector("pre code")?.textContent).toContain("echo example");
    expect(node.querySelector("table")).not.toBeNull();
    expect(node.querySelector("img,script")).toBeNull();
    expect([...node.querySelectorAll("a")].every(a => a.href.startsWith("https://"))).toBe(true);
  } finally { act(() => root.unmount()); }
});
