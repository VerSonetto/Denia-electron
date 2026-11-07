// MCP settings: the `mcp` namespace of the shared settings document.
//
// The UI edits configs through the dedicated endpoints, but the fact source is
// still `settings.yaml` — the same file the Rust build uses.

import {
  loadSettings,
  saveSettingsNamespace,
} from '../config.ts'
import type { McpServerConfig } from './config.ts'
import { normalizeServerConfig, validateMcpNamespace } from './config.ts'

export interface McpSettings {
  servers: McpServerConfig[]
}

export function loadMcpSettings(home: string): McpSettings {
  const document = loadSettings(home)
  const raw = document?.mcp
  if (raw === undefined) return { servers: [] }
  try {
    return validateMcpNamespace(raw)
  } catch {
    // A broken namespace must not take the host down; the UI surfaces the
    // concrete error when it next writes a valid config.
    return { servers: [] }
  }
}

export function saveMcpSettings(home: string, settings: McpSettings): void {
  const value = validateMcpNamespace(settings)
  saveSettingsNamespace(home, 'mcp', {
    servers: value.servers.map((server) => ({
      id: server.id,
      transport: server.transport,
      command: server.command,
      args: server.args,
      env: server.env,
      cwd: server.cwd,
      url: server.url,
      headers: server.headers,
      enabled: server.enabled,
      disabledTools: server.disabledTools,
      scope: server.scope,
      ...(server.workspaceId ? { workspaceId: server.workspaceId } : {}),
      protocolVersion: server.protocolVersion,
      callTimeoutMs: server.callTimeoutMs,
    })),
  })
}

/** Content revision of the namespace: external edits also invalidate it. */
export function mcpRevision(home: string): number {
  const document = loadSettings(home)
  const raw = document?.mcp ?? { servers: [] }
  return fnv1a(JSON.stringify(raw))
}

/** Describe-side secret paths: env and header values never leave the host. */
export function mcpSecretPaths(value: unknown): { path: string[]; set: boolean }[] {
  if (typeof value !== 'object' || value === null) return []
  const servers = (value as { servers?: unknown }).servers
  if (!Array.isArray(servers)) return []
  const out: { path: string[]; set: boolean }[] = []
  servers.forEach((entry, index) => {
    const server = normalizeServerConfig(entry)
    for (const [key, secret] of Object.entries(server.env)) {
      out.push({ path: ['servers', String(index), 'env', key], set: secret !== '' })
    }
    for (const [key, secret] of Object.entries(server.headers)) {
      out.push({ path: ['servers', String(index), 'headers', key], set: secret !== '' })
    }
  })
  return out
}

function fnv1a(text: string): number {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (const byte of Buffer.from(text, 'utf8')) {
    hash ^= BigInt(byte)
    hash = (hash * prime) & 0xffffffffffffffffn
  }
  return Number(hash & 0x1fffffffffffffn)
}