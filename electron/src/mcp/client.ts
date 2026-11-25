// MCP client: handshake + request choreography, independent of transport.
//
// One connection is serialized (one request in flight); parallelism belongs to
// the agent loop's tool pool.

import type { McpServerConfig } from './config.ts'
import { CALL_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from './config.ts'
import {
  METHOD_INITIALIZE,
  METHOD_INITIALIZED,
  METHOD_TOOLS_CALL,
  METHOD_TOOLS_LIST,
  callResultFrom,
  initializeParams,
  parseToolsPage,
} from './protocol.ts'
import type { McpCallResult, McpToolDef } from './protocol.ts'
import { createTransport } from './transport.ts'
import type { McpTransport } from './transport.ts'

/** Upper bound on `tools/list` pages (a page may hold 100+ tools). */
const MAX_TOOL_PAGES = 50

export class McpClient {
  private readonly name: string
  private readonly transport: McpTransport
  private readonly callTimeoutMs: number

  private constructor(name: string, transport: McpTransport, callTimeoutMs: number) {
    this.name = name
    this.transport = transport
    this.callTimeoutMs = callTimeoutMs
  }

  static async connect(config: McpServerConfig): Promise<McpClient> {
    const transport = await createTransport(config)
    const client = new McpClient(
      config.id,
      transport,
      config.callTimeoutMs && config.callTimeoutMs > 0 ? config.callTimeoutMs : CALL_TIMEOUT_MS,
    )
    try {
      await client.handshake()
    } catch (error) {
      await transport.shutdown()
      throw error
    }
    return client
  }

  private async handshake(): Promise<void> {
    try {
      await this.transport.request(METHOD_INITIALIZE, initializeParams(), REQUEST_TIMEOUT_MS)
    } catch (error) {
      throw new Error(`MCP 服务器握手失败:${errorMessage(error)}`)
    }
    try {
      await this.transport.notify(METHOD_INITIALIZED)
    } catch {
      // The notification is best effort: the handshake already succeeded.
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = []
    let cursor: string | null = null
    // Servers such as large reverse-engineering suites paginate the catalog;
    // the page cap keeps a server that never clears its cursor bounded.
    for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
      const result = await this.run(
        METHOD_TOOLS_LIST,
        cursor === null ? undefined : { cursor },
        REQUEST_TIMEOUT_MS,
      )
      const parsed = parseToolsPage(result)
      tools.push(...parsed.tools)
      cursor = parsed.nextCursor
      if (cursor === null) break
    }
    return tools
  }

  async callTool(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.run(
      METHOD_TOOLS_CALL,
      { name: tool, arguments: args },
      this.callTimeoutMs,
      signal,
    )
    return callResultFrom(result)
  }

  private async run(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.transport.request(method, params, timeoutMs, signal)
    } catch (error) {
      throw new Error(`MCP 服务器 ${this.name} 调用失败:${errorMessage(error)}`)
    }
  }

  async shutdown(): Promise<void> {
    await this.transport.shutdown()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}