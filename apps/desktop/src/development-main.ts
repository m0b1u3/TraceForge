import { register } from "@traceforge/server/development-loader";
register();
await import("./main.js");
