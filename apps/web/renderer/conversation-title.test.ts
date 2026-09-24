import {expect,it} from "vitest";
import {conversationTitle} from "./conversation-title";
it("keeps titles compact without URL credentials or query parameters",()=>{
  expect(conversationTitle("检查 https://user:secret@example.test/path?token=private；随后阅读结果")).toBe("检查 example.test");
  expect([...conversationTitle("调查".repeat(60))].length).toBeLessThanOrEqual(29);
  expect(conversationTitle("")).toBe("新对话");
});
