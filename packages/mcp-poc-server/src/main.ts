import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolve } from "node:path";
import { createServer } from "./server.js";

const root = process.env.TRACEFORGE_WORKSPACE ?? resolve(process.cwd(), "../../data/cases");
const server = createServer(root);
const transport = new StdioServerTransport();
await server.connect(transport);
