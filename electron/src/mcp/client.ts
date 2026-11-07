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
  parseToolsList,
} from './protocol.ts'
import type { McpCallResult, McpToolDef } from './protocol.ts'
import { createTransport } from './transport.ts'
import type { McpTransport } from './transport.ts'

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
    const result = await this.run(METHOD_TOOLS_LIST, undefined, REQUEST_TIMEOUT_MS)
    return parseToolsList(result)
  }

  async callTool(tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const result = await this.run(
      METHOD_TOOLS_CALL,
      { name: tool, arguments: args },
      this.callTimeoutMs,
    )
    return callResultFrom(result)
  }

  private async run(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
    try {
      return await this.transport.request(method, params, timeoutMs)
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