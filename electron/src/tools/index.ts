// Built-in tool registry.

import type { ToolSchema } from '../core/wire.ts'
import { BashTool } from './bash.ts'
import { fileTools } from './files.ts'
import { searchTools } from './search.ts'
import { TodoWriteTool } from './todo.ts'
import type { Tool } from './types.ts'

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>()

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool)
  }

  register(tool: Tool): void {
    this.tools.set(tool.schema.name, tool)
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  names(): string[] {
    return [...this.tools.keys()]
  }

  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((tool) => tool.schema)
  }

  static builtin(): ToolRegistry {
    return new ToolRegistry([BashTool, ...fileTools, ...searchTools, TodoWriteTool])
  }
}