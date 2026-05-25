#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.ts";
import { strictifyToolRegistration } from "./tools/helpers.ts";
import { registerAccountTools } from "./tools/account.ts";
import { registerAuthTools } from "./tools/auth.ts";
import { registerMailTools } from "./tools/mail.ts";
import { registerCalendarTools } from "./tools/calendar.ts";
import { registerContactsTools } from "./tools/contacts.ts";

async function main(): Promise<void> {
  // Fail fast on missing config — surfaces a clear message in Claude Code's MCP logs.
  loadConfig();

  const server = new McpServer({
    name: "gmail-mcp",
    version: "0.1.0",
  });

  // Patch server.tool() before any registration so every tool's inputSchema
  // becomes strict (unknown keys reject by name instead of silently dropping).
  strictifyToolRegistration(server);

  registerAccountTools(server);
  registerAuthTools(server);
  registerMailTools(server);
  registerCalendarTools(server);
  registerContactsTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(
    `gmail-mcp fatal: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
