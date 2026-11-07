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
      '技能按作用域分为全局技能与项目技能：全局技能位于用户主目录的 ~/.denia/skills/（跨项目复用），项目技能位于项目 .denia/skills 等目录（随项目走），同名时项目技能优先，来源见返回的 source。可用技能以 <available_skills> 目录注入消息提供，先从目录取准确技能名；action=load 按 name 加载，SKILL.md 全文直接随工具结果返回（加载一次即可，目录只含摘要，未加载前不得凭摘要推断技能内容）；其余参考资料与脚本用 action=resource、name、path 按返回的 resourceBase 相对路径读取，禁止越界。',
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