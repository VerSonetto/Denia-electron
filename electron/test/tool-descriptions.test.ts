// Model-facing tool descriptions are part of the routing surface: the schema
// next to each tool must keep saying which work belongs to bash and which work
// belongs to the dedicated file tools. A previous trim emptied these cues and
// the model fell back to bash for everything.

import assert from 'node:assert/strict'
import test from 'node:test'

import { BashTool } from '../src/tools/bash.ts'
import { EditTool, ReadFileTool, WriteFileTool } from '../src/tools/files.ts'
import { GlobTool, GrepTool, LsTool } from '../src/tools/search.ts'

test('bash names the file work that belongs to dedicated tools', () => {
  const text = BashTool.schema.description
  assert.ok(text.includes('builds, tests, git, installs and process control'), 'bash has a narrow job')
  assert.ok(text.includes('Do not use it for file work'), 'bash refuses file work')
  for (const name of ['ls', 'glob', 'grep', 'read_file', 'write_file', 'edit']) {
    assert.ok(text.includes(name), `bash points at ${name}`)
  }
})

test('every file tool names the bash command it replaces', () => {
  const cases = [
    [LsTool, 'bash ls'],
    [GlobTool, 'bash find'],
    [GrepTool, 'bash grep'],
    [ReadFileTool, 'bash cat'],
    [WriteFileTool, 'bash 重定向'],
    [EditTool, 'bash sed'],
  ] as const
  for (const [tool, needle] of cases) {
    assert.ok(tool.schema.description.includes(needle), `${tool.schema.name} should mention ${needle}`)
  }
})

test('file tools keep their paging defaults on the schema', () => {
  const ls = LsTool.schema.parameters as {
    properties: Record<string, { description?: string }>
  }
  const read = ReadFileTool.schema.parameters as {
    properties: Record<string, { description?: string }>
  }
  assert.equal(ls.properties.depth?.description, '递归深度,默认 1。')
  assert.equal(read.properties.limit?.description, '本次最多读取的行数,默认 400。')
})
