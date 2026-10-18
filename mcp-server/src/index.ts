#!/usr/bin/env node
/**
 * ytagent MCP server - entry point.
 * stdio transport. stdout is the MCP protocol ONLY; all logging goes to stderr.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAll } from "./tools/index.js";

const server = new McpServer({ name: "ytagent", version: "1.0.0" });
registerAll(server);

const transport = new StdioServerTransport();
await server.connect(transport);

console.error(
  "[ytagent] MCP server running on stdio - 11 tools: quota, stats, list, analytics, search, comments x2, metadata, thumbnail, captions, upload."
);
