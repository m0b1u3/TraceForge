import { expect, it } from "vitest";
import { foundationHost, eventually } from "./test-fixtures/foundation-host.js";

it("renews the original lease from explicit script budget before long tool dispatch", async () => {
  const host = await foundationHost({ longTaskScope: { maximumScriptSeconds: 1800 }, toolTimeoutMs: 1830000 });
  try {
    await host.start();
    await eventually(async () => (await host.state()).workItems[0]?.status === "completed");
    const rows = host.sqlite.prepare("SELECT payload_json FROM scenario_events WHERE event_type='work_lease_renewed'").all() as Array<{ payload_json: string }>;
    expect(rows.length).toBeGreaterThan(0);
    const event = JSON.parse(rows[0].payload_json);
    expect(Date.parse(event.leaseExpiresAt) - Date.parse(event.at)).toBe(1830000);
    expect(host.calls()).toBe(1);
  } finally { await host.close(); }
});
