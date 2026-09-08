import { expect, it } from "vitest";
import { readGuidanceFile } from "./user-resources";

it("imports bounded UTF-8 text without interpreting scripts or frontmatter", async () => {
  const text = "---\nname: user guidance\n---\n<script>not executed</script>";
  const file = { name: "SKILL.md", size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer } as File;
  expect(await readGuidanceFile(file)).toBe(text);
  await expect(readGuidanceFile({ ...file, name: "tool.js" } as File)).rejects.toThrow("Markdown");
  await expect(readGuidanceFile({ ...file, size: 65537 } as File)).rejects.toThrow("64 KiB");
  await expect(readGuidanceFile({ ...file, arrayBuffer: async () => new Uint8Array([255]).buffer } as File)).rejects.toThrow("UTF-8");
});
