import { describe, expect, it } from 'vitest';
import { codexMcpOverrides } from '@main/adapters/objective-cli-adapter';

describe('Codex and the sandbox MCP server', () => {
  it('pre-approves the sandbox tools, since the gateway asks the user itself and Codex runs with approvals off', () => {
    const args = codexMcpOverrides([{ key: 'sandbox', url: 'http://127.0.0.1:1/g/t/mcp' }]);
    expect(args).toContain('mcp_servers.sandbox.default_tools_approval_mode="approve"');
  });
  it('leaves other MCP servers to Codex’s normal approval', () => {
    const args = codexMcpOverrides([{ key: 'docs', url: 'https://mcp.example.com/mcp' }]);
    expect(args.join(' ')).not.toContain('approval_mode');
  });
});
