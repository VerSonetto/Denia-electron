import type { IncomingMessage, ServerResponse } from 'node:http'

import type { McpServerConfig } from '../../mcp/config.ts'
import {
  mergeServerConfig,
  normalizeServerConfig,
  validateMcpNamespace,
} from '../../mcp/config.ts'
import type { McpManager } from '../../mcp/manager.ts'
import { mcpRevision, saveMcpSettings } from '../../mcp/settings.ts'
import { isRecord } from '../../core/util.ts'
import { apiError, json, readJson, safeDecode } from '../http.ts'

export interface McpApiContext {
  home: string
  mcp: McpManager
  servers: () => McpServerConfig[]
  ready: () => Promise<void>
  reloadMcp: () => Promise<void>
  broadcast: (event: { type: string; [key: string]: unknown }) => void
}

export async function handleMcpApi(
  ctx: McpApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  const describeMcp = () => ({
    servers: ctx.mcp.snapshot().servers,
    toolCount: ctx.mcp.snapshot().toolDefs().length,
  })
  if (pathname === '/api/mcp' && method === 'GET') {
    await ctx.ready()
    json(res, 200, describeMcp())
    return true
  }
  if (pathname === '/api/mcp/servers' && method === 'PUT') {
    const body = await readJson(req)
    if (!isRecord(body.server)) {
      apiError(res, 400, 'mcp/invalid-server', 'server 必须是对象')
      return true
    }
    const incoming = normalizeServerConfig(body.server)
    const preserve = body.preserveSecrets === true
    const existing = ctx.servers().find((server) => server.id === incoming.id)
    const merged = existing ? mergeServerConfig(existing, incoming, preserve) : incoming
    const servers = existing
      ? ctx.servers().map((server) => (server.id === merged.id ? merged : server))
      : [...ctx.servers(), merged]
    try {
      validateMcpNamespace({ servers })
    } catch (error) {
      apiError(res, 400, 'mcp/invalid-config', errorMessage(error))
      return true
    }
    const expected = typeof body.expectedRevision === 'number' ? body.expectedRevision : undefined
    if (expected !== undefined && expected !== mcpRevision(ctx.home)) {
      apiError(res, 409, 'mcp/revision-conflict', 'MCP 配置已被外部修改，请刷新后重试')
      return true
    }
    try {
      saveMcpSettings(ctx.home, { servers })
    } catch (error) {
      apiError(res, 400, 'mcp/invalid-config', errorMessage(error))
      return true
    }
    await ctx.reloadMcp()
    ctx.broadcast({ type: 'mcp-updated' })
    json(res, 200, describeMcp())
    return true
  }
  const mcpServerMatch = /^\/api\/mcp\/servers\/([^/]+)$/.exec(pathname)
  if (mcpServerMatch) {
    const id = safeDecode(mcpServerMatch[1]!)
    if (method === 'DELETE') {
      if (!ctx.servers().some((server) => server.id === id)) {
        apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${id}`)
        return true
      }
      const servers = ctx.servers().filter((server) => server.id !== id)
      saveMcpSettings(ctx.home, { servers })
      await ctx.reloadMcp()
      ctx.broadcast({ type: 'mcp-updated' })
      json(res, 200, describeMcp())
      return true
    }
    if (method === 'POST') {
      const body = await readJson(req)
      const action = typeof body.action === 'string' ? body.action : ''
      const existing = ctx.servers().find((server) => server.id === id)
      if (action === 'reconnect') {
        if (!existing) {
          apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${id}`)
          return true
        }
        await ctx.mcp.disconnect(id)
        await ctx.reloadMcp()
      } else if (action === 'enable' || action === 'disable') {
        if (!existing) {
          apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${id}`)
          return true
        }
        const servers = ctx.servers().map((server) =>
          server.id === id ? { ...server, enabled: action === 'enable' } : server,
        )
        saveMcpSettings(ctx.home, { servers })
        await ctx.reloadMcp()
      } else {
        apiError(res, 400, 'mcp/unknown-action', `未知的 action:${action}(可用:enable / disable / reconnect)`)
        return true
      }
      ctx.broadcast({ type: 'mcp-updated' })
      json(res, 200, describeMcp())
      return true
    }
  }
  if (pathname === '/api/mcp/tools' && method === 'POST') {
    const body = await readJson(req)
    const serverId = typeof body.server === 'string' ? body.server : ''
    const tool = typeof body.tool === 'string' ? body.tool : ''
    const enabled = body.enabled === true
    const existing = ctx.servers().find((server) => server.id === serverId)
    if (!existing) {
      apiError(res, 404, 'mcp/unknown-server', `未知的 MCP 服务器:${serverId}`)
      return true
    }
    const disabledTools = enabled
      ? existing.disabledTools.filter((name) => name !== tool)
      : existing.disabledTools.includes(tool)
        ? existing.disabledTools
        : [...existing.disabledTools, tool]
    const servers = ctx.servers().map((server) =>
      server.id === serverId ? { ...server, disabledTools } : server,
    )
    saveMcpSettings(ctx.home, { servers })
    await ctx.reloadMcp()
    ctx.broadcast({ type: 'mcp-updated' })
    json(res, 200, describeMcp())
    return true
  }

  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
