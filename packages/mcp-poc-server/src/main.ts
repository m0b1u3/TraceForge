import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const root = process.env.TRACEFORGE_WORKSPACE ?? "./workspace";
const server = createServer(root);
const transport = new StdioServerTransport();
await server.connect(transport);
