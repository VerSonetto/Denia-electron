// Provider configuration, settings and credentials — sourced from the same
// home directory the Rust backend uses (`~/.denia`).
//
// Resolution order for providers:
//   1. `<home>/config.json` — local override used by tests/dev.
//   2. `<home>/settings.yaml` → `llm-openai.providers` — the Rust settings
//      document, so the Electron build reuses the user's existing routes.
//   3. environment variables / built-in default.
//
// API keys resolve through `apiKeyEnv`: process environment first, then
// `<home>/.credentials.yaml` (the same plaintext refs file the Rust build
// writes). Secrets never leave the main process.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { isRecord } from './core/util.ts'

export type WireProtocol = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

export interface ProviderModelConfig {
  id: string
  name?: string
  description?: string
  contextWindow?: number
  inputModalities?: string[]
  thinkingSupported?: boolean
  reasoningEfforts?: string[]
}

export interface ProviderConfig {
  id: string
  name: string
  baseURL: string
  apiKey?: string
  apiKeyEnv?: string
  protocol?: WireProtocol
  models: ProviderModelConfig[]
  defaultContextWindow?: number
  defaultMaxTokens?: number
  headers?: Record<string, string>
  inlineThinkTags?: boolean
}

export interface DefaultSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface AppConfig {
  providers: ProviderConfig[]
  default?: DefaultSelection
}

export type CredentialRefs = Record<string, string>

export interface CredentialInfo {
  configured: boolean
  source?: 'environment' | 'file'
  writable: boolean
}

export function resolveHome(): string {
  const fromEnv = process.env.DENIA_HOME?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  // Same home as the Rust build: sessions, settings, credentials, workspaces.
  return path.join(os.homedir(), '.denia')
}

export function configPath(home: string): string {
  return path.join(home, 'config.json')
}

export function settingsPath(home: string): string {
  return path.join(home, 'settings.yaml')
}

export function credentialsPath(home: string): string {
  return path.join(home, '.credentials.yaml')
}

export function workspacesPath(home: string): string {
  return path.join(home, 'workspaces.json')
}

function readYamlFile(file: string): unknown {
  if (!fs.existsSync(file)) return null
  try {
    return parseYaml(fs.readFileSync(file, 'utf8')) as unknown
  } catch {
    return null
  }
}

function writeYamlFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, stringifyYaml(value, { lineWidth: 0 }), 'utf8')
}

export function loadSettings(home: string): Record<string, unknown> | null {
  const parsed = readYamlFile(settingsPath(home))
  return isRecord(parsed) ? parsed : null
}

export function saveSettingsNamespace(home: string, namespace: string, value: unknown): void {
  const document = loadSettings(home) ?? {}
  document[namespace] = value
  writeYamlFile(settingsPath(home), document)
}

// —— credentials ——

export function loadCredentialRefs(home: string): CredentialRefs {
  const parsed = readYamlFile(credentialsPath(home))
  if (!isRecord(parsed) || !isRecord(parsed.refs)) return {}
  const refs: CredentialRefs = {}
  for (const [key, value] of Object.entries(parsed.refs)) {
    if (typeof value === 'string' && value.trim() !== '') refs[key] = value
  }
  return refs
}

function saveCredentialRefs(home: string, refs: CredentialRefs): void {
  writeYamlFile(credentialsPath(home), { version: 1, refs })
}

export function credentialInfo(home: string, refs: string[]): Record<string, CredentialInfo> {
  const stored = loadCredentialRefs(home)
  const out: Record<string, CredentialInfo> = {}
  for (const ref of refs) {
    if (process.env[ref]?.trim()) {
      out[ref] = { configured: true, source: 'environment', writable: false }
    } else if (stored[ref]?.trim()) {
      out[ref] = { configured: true, source: 'file', writable: true }
    } else {
      out[ref] = { configured: false, writable: true }
    }
  }
  return out
}

export function setCredential(home: string, ref: string, value: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error(`凭据引用名非法:${ref}`)
  if (value.trim() === '') throw new Error('凭据值不能为空')
  if (process.env[ref]?.trim()) {
    throw new Error(`凭据 ${ref} 已被进程环境变量覆盖;请在启动器中取消该环境变量后再写入`)
  }
  const refs = loadCredentialRefs(home)
  refs[ref] = value.trim()
  saveCredentialRefs(home, refs)
}

export function unsetCredential(home: string, ref: string): void {
  const refs = loadCredentialRefs(home)
  if (!(ref in refs)) return
  delete refs[ref]
  saveCredentialRefs(home, refs)
}

function resolveSecret(ref: string | undefined, credentials: CredentialRefs): string | undefined {
  if (!ref) return undefined
  const fromEnv = process.env[ref]
  if (fromEnv?.trim()) return fromEnv.trim()
  const stored = credentials[ref]
  return stored?.trim() ? stored.trim() : undefined
}

// —— providers ——

function normalizeProtocol(value: unknown): WireProtocol {
  return value === 'openai-responses' || value === 'anthropic-messages' || value === 'openai-completions'
    ? value
    : 'openai-completions'
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((entry): entry is string => typeof entry === 'string')
  return out.length > 0 ? out : undefined
}

function modelFromRaw(raw: unknown): ProviderModelConfig | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.trim() === '') return null
  return {
    id: raw.id,
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(typeof raw.contextWindow === 'number' ? { contextWindow: raw.contextWindow } : {}),
    ...(stringArray(raw.inputModalities) ? { inputModalities: stringArray(raw.inputModalities) } : {}),
    ...(typeof raw.thinkingSupported === 'boolean' ? { thinkingSupported: raw.thinkingSupported } : {}),
    ...(stringArray(raw.reasoningEfforts) ? { reasoningEfforts: stringArray(raw.reasoningEfforts) } : {}),
  }
}

function headersFromRaw(raw: unknown): Record<string, string> | undefined {
  if (!isRecord(raw)) return undefined
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string') headers[key] = value
  }
  return Object.keys(headers).length > 0 ? headers : undefined
}

function providerFromRaw(
  id: string,
  raw: unknown,
  credentials: CredentialRefs,
): ProviderConfig | null {
  if (!isRecord(raw) || typeof raw.baseURL !== 'string' || raw.baseURL.trim() === '') return null
  const models = Array.isArray(raw.models)
    ? raw.models.map(modelFromRaw).filter((model): model is ProviderModelConfig => model !== null)
    : []
  const apiKeyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : undefined
  return {
    id,
    name: typeof raw.displayName === 'string' && raw.displayName.trim() ? raw.displayName : id,
    baseURL: raw.baseURL,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(resolveSecret(apiKeyEnv, credentials) ? { apiKey: resolveSecret(apiKeyEnv, credentials) } : {}),
    protocol: normalizeProtocol(raw.protocol),
    models,
    ...(typeof raw.defaultContextWindow === 'number' ? { defaultContextWindow: raw.defaultContextWindow } : {}),
    ...(typeof raw.defaultMaxTokens === 'number' ? { defaultMaxTokens: raw.defaultMaxTokens } : {}),
    ...(headersFromRaw(raw.headers) ? { headers: headersFromRaw(raw.headers) } : {}),
    ...(typeof raw.inlineThinkTags === 'boolean' ? { inlineThinkTags: raw.inlineThinkTags } : {}),
  }
}

export function configFromSettings(
  settings: Record<string, unknown>,
  credentials: CredentialRefs,
): AppConfig | null {
  const section = settings['llm-openai']
  if (!isRecord(section) || !isRecord(section.providers)) return null
  const providers: ProviderConfig[] = []
  for (const [id, raw] of Object.entries(section.providers)) {
    const provider = providerFromRaw(id, raw, credentials)
    if (provider) providers.push(provider)
  }
  if (providers.length === 0) return null
  return {
    providers,
    default: { provider: providers[0]!.id, model: providers[0]!.models[0]?.id ?? 'default' },
  }
}

function envProvider(): ProviderConfig | null {
  const baseURL = process.env.DENIA_OPENAI_BASE_URL?.trim()
  if (!baseURL) return null
  const models = (process.env.DENIA_OPENAI_MODELS ?? process.env.DENIA_MODEL ?? 'default')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => ({ id, name: id }))
  return {
    id: 'openai',
    name: process.env.DENIA_OPENAI_NAME?.trim() || 'OpenAI 兼容',
    baseURL,
    apiKey: process.env.DENIA_OPENAI_API_KEY?.trim() ?? '',
    apiKeyEnv: process.env.DENIA_OPENAI_API_KEY_ENV?.trim(),
    protocol: 'openai-completions',
    models,
  }
}

export function defaultConfig(): AppConfig {
  const provider = envProvider() ?? {
    id: 'openai',
    name: 'OpenAI 兼容',
    baseURL: 'https://api.openai.com/v1',
    apiKey: '',
    apiKeyEnv: 'OPENAI_API_KEY',
    protocol: 'openai-completions' as const,
    models: [{ id: 'gpt-4o-mini', name: 'gpt-4o-mini', contextWindow: 128_000 }],
  }
  return {
    providers: [provider],
    default: { provider: provider.id, model: provider.models[0]?.id ?? 'default' },
  }
}

export function loadConfig(home: string): AppConfig {
  const file = configPath(home)
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AppConfig
      if (Array.isArray(parsed.providers) && parsed.providers.length > 0) return parsed
    } catch {
      // A broken override must not take the host down: fall through to shared settings.
    }
  }
  const settings = loadSettings(home)
  if (settings) {
    const fromSettings = configFromSettings(settings, loadCredentialRefs(home))
    if (fromSettings) return fromSettings
  }
  return defaultConfig()
}

export function saveConfig(home: string, config: AppConfig): void {
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(configPath(home), JSON.stringify(config, null, 2) + '\n', 'utf8')
}

export function resolveApiKey(provider: ProviderConfig): string | undefined {
  if (provider.apiKey?.trim()) return provider.apiKey.trim()
  if (provider.apiKeyEnv) {
    const value = process.env[provider.apiKeyEnv]
    if (value?.trim()) return value.trim()
  }
  return undefined
}

export function resolveDefault(config: AppConfig): DefaultSelection {
  const first = config.providers[0]
  const fallback = { provider: first?.id ?? 'openai', model: first?.models[0]?.id ?? 'default' }
  const candidate = config.default
  if (!candidate) return fallback
  const provider = config.providers.find((entry) => entry.id === candidate.provider)
  if (!provider) return fallback
  if (!provider.models.some((model) => model.id === candidate.model)) return fallback
  return candidate
}

export function findProvider(config: AppConfig, id: string): ProviderConfig | undefined {
  return config.providers.find((provider) => provider.id === id)
}

function mcpSecretsOf(value: unknown): { path: string[]; set: boolean }[] {
  if (!isRecord(value) || !Array.isArray(value.servers)) return []
  const out: { path: string[]; set: boolean }[] = []
  value.servers.forEach((entry, index) => {
    if (!isRecord(entry)) return
    if (isRecord(entry.env)) {
      for (const [key, secret] of Object.entries(entry.env)) {
        out.push({ path: ['servers', String(index), 'env', key], set: typeof secret === 'string' && secret !== '' })
      }
    }
    if (isRecord(entry.headers)) {
      for (const [key, secret] of Object.entries(entry.headers)) {
        out.push({ path: ['servers', String(index), 'headers', key], set: typeof secret === 'string' && secret !== '' })
      }
    }
  })
  return out
}

/** Settings namespace shape the web UI renders (`SettingsDescribe`). */
export function settingsDescribe(home: string, config: AppConfig) {
  const document = loadSettings(home)
  const namespaces: {
    ns: string
    value: unknown
    revision: number
    applies: 'live' | 'restart'
    secrets: { path: string[]; set: boolean }[]
  }[] = []
  if (document) {
    for (const ns of ['console', 'llm-openai', 'mcp']) {
      if (document[ns] === undefined) continue
      namespaces.push({
        ns,
        value: document[ns],
        revision: 1,
        applies: ns === 'llm-openai' ? 'restart' : 'live',
        secrets: ns === 'mcp' ? mcpSecretsOf(document[ns]) : [],
      })
    }
  }
  if (namespaces.length === 0) {
    for (const provider of config.providers) {
      const { apiKey, ...visible } = provider
      namespaces.push({
        ns: `llm-openai/${provider.id}`,
        value: visible,
        revision: 1,
        applies: 'restart',
        secrets: [
          { path: ['apiKey'], set: Boolean(apiKey?.trim()) },
          { path: ['apiKeyEnv'], set: Boolean(provider.apiKeyEnv) },
        ],
      })
    }
  }
  return {
    writable: true,
    documentPath: settingsPath(home),
    namespaces,
  }
}