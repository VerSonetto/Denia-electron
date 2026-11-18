import { allPresetFeatures } from '../agent/presets.ts'
import type { AgentPresetRow } from '../agent/presets.ts'
import { loadSettings } from '../config.ts'
import { presetState, stateFromLegacy } from '../core/permission.ts'
import type { PermissionState } from '../core/permission.ts'
import { isRecord } from '../core/util.ts'

/** 新建会话可用的默认档位。计划模式只在会话内显式进入,不能作默认值。 */
export type DefaultPermission = 'read-only' | 'auto-edit' | 'approve-for-me' | 'full'

/**
 * 设置里的默认权限档位,建会话时读。
 *
 * 只认目录里的四个档位:计划模式必须逐会话显式进入,非法值回落自动编辑
 * (与 Rust 宿主的 console_default_permission_mode 同一判据)。
 */
export function consolePermissionMode(home: string): DefaultPermission {
  const document = loadSettings(home)
  const section = document && isRecord(document.console) ? document.console : null
  const mode = section && typeof section.defaultPermissionMode === 'string'
    ? section.defaultPermissionMode
    : ''
  if (mode === 'read-only' || mode === 'full' || mode === 'auto-edit') return mode
  if (mode === 'approve-for-me') return mode
  return 'auto-edit'
}

/** 默认档位 → 完整权限状态;自动审批是独立预设,不能走四档的 legacy 映射。 */
export function permissionPresetState(choice: DefaultPermission): PermissionState {
  return choice === 'approve-for-me' ? presetState('approve-for-me') : stateFromLegacy(choice)
}

function allFeatures(enabled: boolean) {
  return allPresetFeatures(enabled)
}

/** Shipped presets, mirroring `denia_core::preset::builtin_presets`. */
export function builtinPresetRows(): AgentPresetRow[] {
  return [
    {
      id: 'standard',
      name: '标准模式',
      description: '功能完整的编码 Agent:文件读写、Shell、检索、计划、目标、子代理与后台任务。',
      hasPersona: false,
      features: allFeatures(true),
    },
    {
      id: 'creator',
      name: '创造模式',
      description: '让 Agent 帮你创建新预设:通过提问收集 persona、工具面与功能开关,直接落盘可用的 preset.yml。',
      hasPersona: true,
      features: allFeatures(true),
    },
    {
      id: 'minimal',
      name: '极简模式',
      description: '只有持久 shell 的极简 Agent:系统提示一句话,无检索、记忆、计划与委派。',
      tools: ['bash'],
      hasPersona: true,
      features: allFeatures(false),
    },
  ]
}
