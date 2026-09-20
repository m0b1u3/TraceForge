import { expect, it } from "vitest";
import { desktopToolOutcome } from "./desktop-tool-outcome.js";
it("reports explicit failures before truncation without interpreting retrieved prose as status", () => {
  expect(desktopToolOutcome(JSON.stringify({padding:"x".repeat(5000),error:"memory_revision_conflict"}))).toBe("failed");
  expect(desktopToolOutcome(JSON.stringify({text:'{"error":"quoted historical data"}'}))).toBe("returned");
  expect(desktopToolOutcome(JSON.stringify({isError:true}))).toBe("failed");
  expect(desktopToolOutcome(JSON.stringify({status:"failed"}))).toBe("failed");
  expect(desktopToolOutcome(JSON.stringify({error:null,revision:1}))).toBe("returned");
  expect(desktopToolOutcome("corrupt")).toBe("failed");
});
