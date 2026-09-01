import { setTimeout as delay } from "node:timers/promises";
import { runReliabilityCycle } from "./foundation-reliability-host.mjs";

const [root, seconds, interval, maximum] = process.argv.slice(2);
const start = performance.now(); let cycles = 0, peakRssBytes = 0;
while ((performance.now() - start) / 1000 < Number(seconds) && cycles < Number(maximum)) {
  const observation = await runReliabilityCycle(root, String(cycles), "resident", "continuous-host", false);
  if (observation.physical.admission !== "available") throw new Error("Resident host physical admission blocked");
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  if (peakRssBytes > 512 * 1024 * 1024) throw new Error("Resident host exceeds its 512 MiB acceptance RSS ceiling");
  cycles++;
  process.stdout.write(JSON.stringify({ cycles, peakRssBytes, elapsedSeconds: (performance.now() - start) / 1000,
    physical: observation.physical, completed: false }) + "\n");
  const remaining = Number(seconds) * 1000 - (performance.now() - start);
  if (cycles < Number(maximum) && remaining > 0) await delay(Math.min(Number(interval), remaining));
}
process.stdout.write(JSON.stringify({ cycles, peakRssBytes, elapsedSeconds: (performance.now() - start) / 1000, completed: true }) + "\n");
