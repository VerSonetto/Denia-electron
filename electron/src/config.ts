// Provider configuration and defaults.
//
// The desktop app owns one JSON document at `<home>/config.json`. Providers
// are OpenAI-compatible routes for now; the shape is intentionally close to
// the Rust `llm-openai` settings section so the UI can grow into the same
// settings surface later.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

export function resolveHome(): string {
  const fromEnv = process.env.DENIA_HOME?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return path.join(os.homedir(), '.denia-electron')
}

export function configPath(home: string): string {
  return path.join(home, 'config.json')
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
      // A broken document must not take the host down: fall back to env.
    }
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

/** Settings namespace shape the web UI renders (`SettingsDescribe`). */
export function settingsDescribe(home: string, config: AppConfig) {
  const namespaces = config.providers.map((provider) => {
    const { apiKey, ...visible } = provider
    return {
      ns: `llm-openai/${provider.id}`,
      value: visible,
      revision: 1,
      applies: 'restart' as const,
      secrets: [
        { path: ['apiKey'], set: Boolean(apiKey?.trim()) },
        { path: ['apiKeyEnv'], set: Boolean(provider.apiKeyEnv) },
      ],
    }
  })
  return {
    writable: true,
    documentPath: configPath(home),
    namespaces,
  }
}