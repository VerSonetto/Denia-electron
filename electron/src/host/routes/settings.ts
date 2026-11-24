import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import { presetRows, presetSettings } from '../../agent/presets.ts'
import type { AppConfig } from '../../config.ts'
import {
  credentialInfo,
  loadConfig,
  loadCredentialRefs,
  saveSettingsNamespace,
  setCredential,
  settingsDescribe,
  unsetCredential,
} from '../../config.ts'
import { isRecord } from '../../core/util.ts'
import type { McpManager } from '../../mcp/manager.ts'
import type { SubagentRuntime } from '../../subagents/runtime.ts'
import { subagentPolicyConcurrency } from '../helpers.ts'
import { apiError, json, notImplemented, readJson, safeDecode } from '../http.ts'

export interface SettingsApiContext {
  home: string
  config: () => AppConfig
  setConfig: (next: AppConfig) => void
  mcp: McpManager
  subagents: SubagentRuntime
  describedToolNames: () => string[]
  reloadMcp: () => Promise<void>
  broadcast: (event: { type: string; [key: string]: unknown }) => void
}

export async function handleSettingsApi(
  ctx: SettingsApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<boolean> {
  if (pathname === '/api/settings' && method === 'GET') {
    json(res, 200, settingsDescribe(ctx.home, ctx.config()))
    return true
  }
  const settingsMatch = /^\/api\/settings\/(.+)$/.exec(pathname)
  if (settingsMatch && (method === 'PATCH' || method === 'PUT')) {
    const ns = safeDecode(settingsMatch[1]!)
    const body = await readJson(req)
    if (ns === 'subagent-policy') {
      const value = body.value
      if (
        !isRecord(value) ||
        !Number.isInteger(value.maxConcurrentRuns) ||
        (value.maxConcurrentRuns as number) < 1 ||
        (value.maxConcurrentRuns as number) > 64
      ) {
        apiError(res, 400, 'subagent-policy/invalid', 'maxConcurrentRuns 必须是 1–64 的整数')
        return true
      }
    }
    saveSettingsNamespace(ctx.home, ns, body.value)
    ctx.setConfig(loadConfig(ctx.home))
    if (ns === 'subagent-policy') {
      ctx.subagents.setConcurrencyLimit(subagentPolicyConcurrency(ctx.home))
    }
    if (ns === 'mcp') {
      await ctx.reloadMcp()
      ctx.broadcast({ type: 'mcp-updated' })
    }
    ctx.broadcast({ type: 'settings-updated' })
    json(res, 200, { revision: 1, applies: 'restart' })
    return true
  }
  if (pathname === '/api/credentials' && method === 'GET') {
    const refs = (url.searchParams.get('refs') ?? '')
      .split(',')
      .map((ref) => ref.trim())
      .filter(Boolean)
    json(res, 200, { credentials: credentialInfo(ctx.home, refs) })
    return true
  }
  // 本机桌面应用:凭据存在本机明文 YAML,读取回显供设置界面查看/编辑。
  const credentialValueMatch = /^\/api\/credentials\/(.+)\/value$/.exec(pathname)
  if (credentialValueMatch && method === 'GET') {
    const ref = safeDecode(credentialValueMatch[1]!)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
      apiError(res, 400, 'credential/invalid', '凭据引用名非法')
      return true
    }
    const value = process.env[ref]?.trim() || loadCredentialRefs(ctx.home)[ref]?.trim() || ''
    json(res, 200, { value })
    return true
  }
  if (pathname.startsWith('/api/credentials/') && (method === 'PUT' || method === 'DELETE')) {
    const ref = safeDecode(pathname.slice('/api/credentials/'.length))
    try {
      if (method === 'PUT') {
        const body = await readJson(req)
        if (typeof body.value !== 'string') {
          apiError(res, 400, 'credential/invalid-value', 'value 必须是字符串')
          return true
        }
        setCredential(ctx.home, ref, body.value)
      } else {
        unsetCredential(ctx.home, ref)
      }
      ctx.broadcast({ type: 'credentials-updated' })
      json(res, 200, { ok: true, credentials: credentialInfo(ctx.home, [ref]) })
    } catch (error) {
      apiError(res, 400, 'credential/invalid', errorMessage(error))
    }
    return true
  }

  if (pathname === '/api/agent-presets' && method === 'GET') {
    json(res, 200, {
      ...presetSettings(ctx.home),
      root: path.join(ctx.home, 'agent-presets'),
      tools: ctx.describedToolNames(),
      presets: presetRows(ctx.home),
    })
    return true
  }
  const presetMatch = /^\/api\/agent-presets\/([^/]+)$/.exec(pathname)
  if (presetMatch && method === 'GET') {
    const id = safeDecode(presetMatch[1]!)
    const preset = presetRows(ctx.home).find((entry) => entry.id === id)
    if (!preset) {
      apiError(res, 404, 'preset/not-found', 'preset not found')
      return true
    }
    json(res, 200, { preset, text: '', spec: null })
    return true
  }
  if (pathname.startsWith('/api/agent-presets') && method !== 'GET') {
    notImplemented(res, pathname)
    return true
  }

  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
