import { randomUUID } from 'node:crypto';
import { MCP_MAX_HEALTH_CHECK_INTERVAL_MS, type McpServer } from '@shared/mcp';
import type { CodexMcpServer } from '../adapters/objective-cli-adapter';
import type { McpRegistry } from './mcp-registry';
import { parseEndpoint, type SdkMcpTransport } from './sdk-transport';

// User-facing MCP operations on top of the registry:
//  add → registered untrusted + disabled (nothing is launched or contacted);
//  approve → trusted + enabled, then connect once to list the server's tools;
//  health checks every 60 s for enabled servers;
//  approved servers can be handed to Codex for agent runs.

export class McpService {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly registry: McpRegistry, private readonly transport: SdkMcpTransport) {}

  list(): McpServer[] {
    return this.registry.list();
  }

  discover() {
    return this.registry.discover();
  }

  add(input: { name: string; endpoint: string }): McpServer {
    parseEndpoint(input.endpoint); // validate before persisting
    const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'server';
    return this.registry.register({ id: `${slug}-${randomUUID().slice(0, 8)}`, name: input.name, endpoint: input.endpoint });
  }

  /** Approve, enable and list tools. Rolls back to disabled if the server cannot be reached. */
  async approve(id: string): Promise<McpServer> {
    this.registry.approve(id, 'user');
    const enabled = this.registry.enable(id);
    try {
      const tools = await this.transport.listTools(enabled);
      this.registry.setCapabilities(id, tools);
      return await this.registry.checkHealth(id);
    } catch (error) {
      await this.transport.disconnect(id);
      this.registry.disable(id);
      throw new Error(`Could not start or reach the MCP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disable(id: string): Promise<McpServer> {
    await this.transport.disconnect(id);
    return this.registry.disable(id);
  }

  async remove(id: string): Promise<void> {
    await this.transport.disconnect(id);
    this.registry.remove(id);
  }

  checkHealth(id: string): Promise<McpServer> {
    return this.registry.checkHealth(id);
  }

  invoke(input: { id: string; tool: string; args?: Record<string, unknown> }) {
    return this.registry.invoke({ serverId: input.id, capabilityId: input.tool, args: input.args ?? {}, caller: 'user' });
  }

  startHealthChecks(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => { void this.registry.runHealthChecks().catch(() => undefined); }, MCP_MAX_HEALTH_CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.transport.closeAll();
  }

  /** Approved, enabled servers in the form Codex accepts as `-c mcp_servers.*` overrides. */
  forAgents(): CodexMcpServer[] {
    return this.registry.list()
      .filter((server) => server.trustStatus === 'trusted' && server.enablement === 'enabled' && server.health !== 'unhealthy')
      .flatMap((server) => {
        try {
          const endpoint = parseEndpoint(server.endpoint);
          const key = server.id.toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 64);
          return [endpoint.kind === 'http'
            ? { key, url: endpoint.url!.toString() }
            : { key, command: endpoint.command!, args: endpoint.args ?? [] }];
        } catch {
          return [];
        }
      });
  }
}
