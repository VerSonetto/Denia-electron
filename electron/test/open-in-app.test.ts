// The shared console's "open workspace with app" split button depends on three
// host endpoints. These checks keep the contract (and the path guards) honest
// without launching a real GUI app.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { startHost } from '../src/host/server.ts'

async function postOpen(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/open-in-app/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('open-in-app exposes local apps and validates launch requests', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-open-apps-home-'))
  const webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-open-apps-web-'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'denia-open-apps-cwd-'))
  const host = await startHost({ home, webDir, port: 0 })
  try {
    const response = await fetch(`${host.baseUrl}/api/open-in-app/apps`)
    assert.equal(response.status, 200)
    const { apps } = (await response.json()) as { apps: string[] }
    assert.ok(Array.isArray(apps))
    assert.ok(apps.every((id) => typeof id === 'string' && id !== ''))
    assert.equal(new Set(apps).size, apps.length)
    if (process.platform === 'win32') {
      // Explorer ships with Windows, so a loopback Windows host must resolve it.
      assert.ok(apps.includes('explorer'), `apps: ${apps.join(',')}`)
    }

    const missingIcon = await fetch(`${host.baseUrl}/api/open-in-app/icon/not-an-app`)
    assert.equal(missingIcon.status, 404)

    const relative = await postOpen(host.baseUrl, { app: 'explorer', path: 'relative/dir' })
    assert.equal(relative.status, 400)
    assert.equal(((await relative.json()) as { error: { code: string } }).error.code, 'open-in-app/bad-path')

    const missingDir = await postOpen(host.baseUrl, {
      app: 'explorer',
      path: path.join(cwd, 'does-not-exist'),
    })
    assert.equal(missingDir.status, 404)
    assert.equal(((await missingDir.json()) as { error: { code: string } }).error.code, 'open-in-app/dir-not-found')

    // A valid directory with an app id the catalog never resolved: reject
    // before spawning anything.
    const unknownApp = await postOpen(host.baseUrl, { app: 'not-an-app', path: cwd })
    assert.equal(unknownApp.status, 400)
    assert.equal(((await unknownApp.json()) as { error: { code: string } }).error.code, 'open-in-app/unknown-app')
  } finally {
    await host.close()
  }
})