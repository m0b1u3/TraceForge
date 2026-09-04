#!/usr/bin/env node
import { runChromiumControllerProcess } from "./node-controller-entry.js";

void runChromiumControllerProcess().catch(() => {
  // Startup details can contain installation paths. The Host receives only the failed process state.
  process.exitCode = 1;
  process.stdin.destroy();
  process.stdout.end();
});
