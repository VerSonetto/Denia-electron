// Windows shell resolution: Windows Terminal's default profile wins, with
// ComSpec as the fallback. These tests pin the profile parsing (JSONC, dynamic
// GUIDs, WSL args) without touching the real machine configuration.

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveShellChoice, shellFromExecutable, shellFromTerminalSettings, shellInvocation } from '../src/tools/bash.ts'

const env = {
  SystemRoot: 'C:\\Windows',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
} as NodeJS.ProcessEnv

const noFind = () => null

test('the default Windows PowerShell profile resolves to powershell.exe', () => {
  const text = String.raw`{
    // Windows Terminal stores JSONC, not strict JSON.
    "defaultProfile": "{61C54BBD-C2C6-5271-96E7-009A87FF44BF}",
    "profiles": {
      "defaults": {},
      "list": [
        {
          "guid": "{61c54bbd-c2c6-5271-96e7-009a87ff44bf}",
          "name": "Windows PowerShell",
          "commandline": "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        },
      ],
    },
  }`

  const choice = shellFromTerminalSettings(text, { env, find: noFind })
  assert.ok(choice)
  assert.equal(choice.dialect, 'powershell')
  assert.equal(choice.label, 'Windows PowerShell')
  assert.deepEqual(choice.args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
  assert.equal(choice.verbatim, false)
  assert.match(choice.file.replaceAll('\\', '/'), /\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe$/)
})

test('a Git Bash profile keeps the executable but drops interactive flags', () => {
  const text = String.raw`{
    "defaultProfile": "{2f9b3c7e-6d4a-4b8e-9c1f-3a5d7e9b1c2d}",
    "profiles": { "list": [
      {
        "guid": "{2f9b3c7e-6d4a-4b8e-9c1f-3a5d7e9b1c2d}",
        "commandline": "C:\\Dev\\git\\bin\\bash.exe --login -i",
      },
    ] },
  }`

  const choice = shellFromTerminalSettings(text, { env, find: noFind })
  assert.ok(choice)
  assert.equal(choice.dialect, 'bash')
  assert.equal(choice.file, 'C:\\Dev\\git\\bin\\bash.exe')
  assert.deepEqual(choice.args, ['-lc'])
})

test('dynamic built-in profiles fall back to their known executable', () => {
  const windowsPowerShell = shellFromTerminalSettings(
    String.raw`{"defaultProfile":"{61c54bbd-c2c6-5271-96e7-009a87ff44bf}","profiles":{"list":[]}}`,
    { env, find: noFind },
  )
  assert.equal(windowsPowerShell?.dialect, 'powershell')
  assert.match(windowsPowerShell?.file.replaceAll('\\', '/') ?? '', /powerShell\.exe$/i)

  const powershell7 = shellFromTerminalSettings(
    String.raw`{"defaultProfile":"{574e775e-4f2a-5b96-ac1e-a2962a402336}","profiles":{"list":[]}}`,
    {
      env,
      find: (name) => (name === 'pwsh.exe' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    },
  )
  assert.equal(powershell7?.dialect, 'powershell')
  assert.equal(powershell7?.label, 'PowerShell')
  assert.equal(powershell7?.file, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
})

test('the array-shaped legacy profile list still resolves cmd', () => {
  const choice = shellFromTerminalSettings(
    String.raw`{
      "defaultProfile": "{0caa0dad-35be-5f56-a8ff-afceeeaa6101}",
      "profiles": [{ "guid": "{0CAA0DAD-35BE-5F56-A8FF-AFCEEEAA6101}" }],
    }`,
    { env, find: noFind },
  )
  assert.equal(choice?.dialect, 'cmd')
  assert.equal(choice?.verbatim, true)
  assert.deepEqual(choice?.args, ['/d', '/s', '/c'])
})

test('a WSL profile keeps its distribution selection', () => {
  const text = String.raw`{
    "defaultProfile": "{2f9b3c7e-6d4a-4b8e-9c1f-3a5d7e9b1c2d}",
    "profiles": { "list": [
      {
        "guid": "{2f9b3c7e-6d4a-4b8e-9c1f-3a5d7e9b1c2d}",
        "commandline": "wsl.exe -d Ubuntu",
      },
    ] },
  }`

  const choice = shellFromTerminalSettings(text, { env, find: noFind })
  assert.equal(choice?.dialect, 'wsl')
  assert.deepEqual(choice?.args, ['-d', 'Ubuntu', '-e', 'bash', '-lc'])
})

test('a conhost default terminal ignores Windows Terminal profiles', () => {
  const choice = resolveShellChoice({
    platform: 'win32',
    env,
    delegationConsole: '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}',
    readText: () => String.raw`{"defaultProfile":"{61c54bbd-c2c6-5271-96e7-009a87ff44bf}"}`,
  })
  assert.equal(choice.dialect, 'cmd')
  assert.equal(choice.file, 'C:\\Windows\\System32\\cmd.exe')
})

test('let Windows decide reads the Windows Terminal default profile', () => {
  const choice = resolveShellChoice({
    platform: 'win32',
    env,
    delegationConsole: '{00000000-0000-0000-0000-000000000000}',
    readText: () => String.raw`{"defaultProfile":"{0caa0dad-35be-5f56-a8ff-afceeeaa6101}"}`,
  })
  assert.equal(choice.dialect, 'cmd')
})

test('a malformed settings file falls back to ComSpec instead of throwing', () => {
  const choice = resolveShellChoice({
    platform: 'win32',
    env,
    delegationConsole: '{00000000-0000-0000-0000-000000000000}',
    readText: () => '{ "defaultProfile": ',
  })
  assert.equal(choice.dialect, 'cmd')
})

test('DENIA_SHELL overrides the default terminal', () => {
  const choice = resolveShellChoice({
    platform: 'win32',
    env: { ...env, DENIA_SHELL: 'pwsh' },
    find: (name) => (name === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
    readText: () => String.raw`{"defaultProfile":"{61c54bbd-c2c6-5271-96e7-009a87ff44bf}"}`,
  })
  assert.equal(choice.dialect, 'powershell')
  assert.equal(choice.file, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe')
})

test('non-Windows keeps the plain bash -c contract', () => {
  const choice = resolveShellChoice({
    platform: 'linux',
    env: {} as NodeJS.ProcessEnv,
    find: (name) => (name === 'bash' ? '/bin/bash' : null),
  })
  assert.equal(choice.dialect, 'bash')
  assert.deepEqual(choice.args, ['-c'])
})

test('executables are classified by name, never assumed to be Git Bash', () => {
  assert.equal(shellFromExecutable('C:\\Windows\\System32\\bash.exe').dialect, 'bash')
  assert.equal(shellFromExecutable('C:\\Windows\\System32\\bash.exe').verbatim, false)
  assert.equal(shellFromExecutable('C:\\Windows\\System32\\WSL.exe').dialect, 'wsl')
  assert.equal(shellFromExecutable('C:\\Windows\\System32\\cmd.exe').verbatim, true)
  assert.equal(shellFromExecutable('/usr/bin/fish').args[0], '-c')
})

test('a git-bash launcher resolves to its sibling bin/bash.exe', () => {
  const text = String.raw`{
    "defaultProfile": "{2f9b3c7e-6d4a-4b8e-9c1f-3a5d7e9b1c2d}",
    "profiles": { "list": [
      {
        "guid": "{2f9b3c7e-6d4a-4b8e-9c1f-3a5d7e9b1c2d}",
        "commandline": "\"C:\\Program Files\\Git\\git-bash.exe\"",
      },
    ] },
  }`

  const choice = shellFromTerminalSettings(text, {
    env,
    find: noFind,
    exists: (file) => file.replaceAll('\\', '/').endsWith('Git/bin/bash.exe'),
  })
  assert.equal(choice?.dialect, 'bash')
  assert.match(choice?.file.replaceAll('\\', '/') ?? '', /Git\/bin\/bash\.exe$/)
  assert.deepEqual(choice?.args, ['-lc'])
})

test('PowerShell commands carry a UTF-8 preamble; other shells do not', () => {
  const powershell = shellFromExecutable('powershell.exe')
  assert.match(powershell.commandPrefix, /Out-File:Encoding/)
  const call = shellInvocation(powershell, 'echo hi > out.txt')
  assert.equal(call.args.at(-1), `${powershell.commandPrefix}echo hi > out.txt`)

  const cmd = shellInvocation(shellFromExecutable('cmd.exe'), 'dir')
  assert.equal(cmd.args.at(-1), 'dir')
})
