import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Envelope, SessionHeader } from '../core/wire.ts'

import { loadSettings } from '../config.ts'
import { isRecord } from '../core/util.ts'

export interface PresetFeatures {
  agentsMd: boolean
  memory: boolean
  compaction: boolean
  goal: boolean
  taskLedger: boolean
  skills: boolean
  subagents: boolean
  jobs: boolean
  browser: boolean
  ask: boolean
  planMode: boolean
}

export interface AgentPresetSpec {
  tools?: string[]
  persona?: string
  features: PresetFeatures
}

export interface AgentPresetRow {
  id: string
  name: string
  description: string
  tools?: string[]
  hasPersona: boolean
  features: PresetFeatures
}

const FEATURE_KEYS = [
  'agentsMd',
  'memory',
  'compaction',
  'goal',
  'taskLedger',
  'skills',
  'subagents',
  'jobs',
  'browser',
  'ask',
  'planMode',
] as const

export function allPresetFeatures(enabled: boolean): PresetFeatures {
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, enabled])) as unknown as PresetFeatures
}

export function excludedPresetTools(features: PresetFeatures): string[] {
  return [
    ...(features.goal ? [] : ['get_goal', 'update_goal', 'goal_read']),
    ...(features.taskLedger ? [] : ['run_checks']),
    ...(features.skills ? [] : ['skill']),
    ...(features.subagents ? [] : ['spawn_agent', 'fork_agent', 'create_subagent', 'send_message', 'interrupt_agent', 'list_agents', 'wait_agent']),
    ...(features.jobs ? [] : ['job_start', 'job_list', 'job_output', 'job_kill']),
    ...(features.browser ? [] : ['browser']),
    ...(features.ask ? [] : ['ask']),
    ...(features.planMode ? [] : ['exit_plan']),
  ]
}

export function presetIdOf(
  events: readonly { type: string; preset?: string }[],
  header: { agent_preset?: string },
): string {
  if (header.agent_preset) return header.agent_preset
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type === 'agent-preset' && typeof event.preset === 'string') return event.preset
  }
  return 'standard'
}

/** Missing or invalid presets fall back to the shipped standard definition. */
export function resolvePreset(home: string, id: string | undefined): AgentPresetSpec {
  if (id === 'minimal') return { tools: ['bash'], features: allPresetFeatures(false) }
  if (id === 'creator') return { features: allPresetFeatures(true) }
  if (id && id !== 'standard' && /^[a-z0-9][a-z0-9-]*$/.test(id)) {
    try {
      const raw: unknown = parseYaml(fs.readFileSync(path.join(home, 'agent-presets', id, 'preset.yml'), 'utf8'))
      if (isRecord(raw)) {
        const features = allPresetFeatures(true)
        if (raw.features !== undefined) {
          if (!isRecord(raw.features) || Object.keys(raw.features).some((key) => !FEATURE_KEYS.includes(key as typeof FEATURE_KEYS[number]))) {
            return { features: allPresetFeatures(true) }
          }
          for (const key of FEATURE_KEYS) {
            if (typeof raw.features[key] !== 'boolean' && raw.features[key] !== undefined) {
              return { features: allPresetFeatures(true) }
            }
            if (raw.features[key] === false) features[key] = false
          }
        }
        const tools = Array.isArray(raw.tools) && raw.tools.length > 0 && raw.tools.every((name) => typeof name === 'string' && name.trim() !== '')
          ? raw.tools as string[]
          : undefined
        const persona = typeof raw.persona === 'string' && raw.persona.trim() !== '' ? raw.persona.trimEnd() : undefined
        return { ...(tools ? { tools } : {}), ...(persona ? { persona } : {}), features }
      }
    } catch {
      // A malformed preset has no valid narrowed grant; use the default.
    }
  }
  return { features: allPresetFeatures(true) }
}

export function presetForSession(home: string, header: SessionHeader, events: readonly Envelope[]): AgentPresetSpec {
  return resolvePreset(home, presetIdOf(events, header))
}

export function presetSettings(home: string): { default: string; modeSelection: boolean } {
  const settings = loadSettings(home)?.['agent-presets']
  const modeSelection = !isRecord(settings) || settings.modeSelectionEnabled !== false
  const id = isRecord(settings) && typeof settings.default === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(settings.default)
    ? settings.default
    : 'standard'
  return { default: modeSelection && presetExists(home, id) ? id : 'standard', modeSelection }
}

function presetExists(home: string, id: string): boolean {
  return ['standard', 'creator', 'minimal'].includes(id) || fs.existsSync(path.join(home, 'agent-presets', id, 'preset.yml'))
}

export function presetRows(home: string): AgentPresetRow[] {
  const rows: AgentPresetRow[] = [
    { id: 'standard', name: '标准模式', description: '功能完整的编码 Agent:文件读写、Shell、检索、计划、目标、子代理与后台任务。', hasPersona: false, features: allPresetFeatures(true) },
    { id: 'creator', name: '创造模式', description: '让 Agent 帮你创建新预设:通过提问收集 persona、工具面与功能开关,直接落盘可用的 preset.yml。', hasPersona: true, features: allPresetFeatures(true) },
    { id: 'minimal', name: '极简模式', description: '只有持久 shell 的极简 Agent:系统提示一句话,无检索、记忆、计划与委派。', tools: ['bash'], hasPersona: true, features: allPresetFeatures(false) },
  ]
  const root = path.join(home, 'agent-presets')
  for (const name of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || rows.some((row) => row.id === name)) continue
    try {
      const raw: unknown = parseYaml(fs.readFileSync(path.join(root, name, 'preset.yml'), 'utf8'))
      if (!isRecord(raw)) continue
      const preset = resolvePreset(home, name)
      rows.push({
        id: name,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : name,
        description: typeof raw.description === 'string' ? raw.description : '',
        ...(preset.tools ? { tools: preset.tools } : {}),
        hasPersona: Boolean(preset.persona),
        features: preset.features,
      })
    } catch {
      // Invalid definitions stay out of the dispatch catalog and preset picker.
    }
  }
  return rows
}
