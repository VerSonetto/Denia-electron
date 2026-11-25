// `skill` tool: list summaries, load the full SKILL.md, read a resource.
//
// Bodies are re-read on every load so an edited skill never runs stale text.

import path from 'node:path'

import type { ToolSchema } from '../core/wire.ts'
import type { Tool, ToolContext } from './types.ts'
import { toolError } from './types.ts'
import {
  discoverSkills,
  loadSkill,
  readSkillResource,
  type Skill,
} from '../skills/skills.ts'

function summaryOf(skill: Skill): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    source: skill.source,
    path: skill.path,
    resourceBase: skill.resourceBase,
    modelInvocable: skill.modelInvocable,
    userInvocable: skill.userInvocable,
  }
}

export class SkillTool implements Tool {
  readonly schema: ToolSchema = {
    name: 'skill',
    description:
      '加载技能。名字从 <available_skills> 取准确值;action=load 返回 SKILL.md 全文(只加载一次,未加载前不得凭摘要推断)。其余资料用 action=resource + path,按返回的 resourceBase 相对路径读。同名时项目技能优先,来源见 source。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'load', 'resource'] },
        name: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['action'],
    },
  }
  private readonly home: string

  constructor(home: string) {
    this.home = home
  }

  async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<{
    content: string
    isError: boolean
  }> {
    const action = typeof args.action === 'string' ? args.action : ''
    try {
      const discovery = discoverSkills(this.home, ctx.cwd)
      if (action === 'list') {
        return {
          content: JSON.stringify(
            discovery.skills.filter((skill) => skill.modelInvocable).map(summaryOf),
          ),
          isError: false,
        }
      }
      if (action !== 'load' && action !== 'resource') {
        return toolError('action 必须是 list / load / resource', '先看 <available_skills> 目录再调用')
      }
      const name = typeof args.name === 'string' ? args.name.trim() : ''
      if (name === '') return toolError('name 不能为空', '从 <available_skills> 目录取准确技能名')
      if (action === 'load') {
        const loaded = loadSkill(discovery.skills, name, false)
        return {
          content: JSON.stringify({ skill: summaryOf(loaded.skill), body: loaded.body }),
          isError: false,
        }
      }
      const resourcePath = typeof args.path === 'string' ? args.path : ''
      if (resourcePath === '') return toolError('path 不能为空', '传相对 resourceBase 的路径')
      const resource = readSkillResource(discovery.skills, name, resourcePath)
      return { content: JSON.stringify(resource), isError: false }
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : String(error),
        '目录只含摘要；加载后按正文执行。资源路径必须落在技能目录内',
      )
    }
  }
}

/** Normalize a user-selected resource path relative to a skill base. */
export function safeSkillRelative(base: string, candidate: string): string {
  const resolved = path.resolve(base, candidate)
  const relative = path.relative(base, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('技能资源路径超出技能目录')
  }
  return relative
}