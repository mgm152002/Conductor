// Minimal MCP stdio server used by tests: one `echo` tool and one `add` tool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo the text back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}));
server.registerTool('add', { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
  content: [{ type: 'text', text: String(a + b) }],
}));
await server.connect(new StdioServerTransport());
