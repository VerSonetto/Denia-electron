import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import type { BrowserManager } from '../../browser/manager.ts'
import type { AppConfig } from '../../config.ts'
import { findProvider } from '../../config.ts'
import { streamFor } from '../../llm/index.ts'
import type { UsageIndex } from '../../session/usage.ts'
import { isUsageRange } from '../../session/usage.ts'
import { HEARTBEAT_MS } from '../events.ts'
import { GitError, gitCommit, gitCommitContext, gitDiff, gitPush, gitStatus } from '../git.ts'
import { emptyQqbotStatus, emptyWeixinStatus } from '../helpers.ts'
import { apiError, json, readJson, sseHeaders, writeSse } from '../http.ts'
import { availableApps, iconFor, launchApp } from '../open-in-app.ts'
import type { Updater } from '../update.ts'

export interface IntegrationsApiContext {
  localOnly: boolean
  browser: BrowserManager | null
  updater: Updater
  usage: UsageIndex
  config: () => AppConfig
  broadcast: (event: { type: string; [key: string]: unknown }) => void
}

export async function handleIntegrationsApi(
  ctx: IntegrationsApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  url: URL,
  method: string,
): Promise<boolean> {
  const openInAppIcon = /^\/api\/open-in-app\/icon\/([A-Za-z0-9_-]+)$/.exec(pathname)
  if (openInAppIcon !== null && method === 'GET') {
    const png = ctx.localOnly ? await iconFor(openInAppIcon[1]!) : null
    if (png === null) {
      apiError(res, 404, 'open-in-app/no-icon', `no icon for app '${openInAppIcon[1]}'`)
      return true
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=3600',
    })
    res.end(png)
    return true
  }
  if (pathname === '/api/open-in-app/open' && method === 'POST') {
    if (!ctx.localOnly) {
      apiError(res, 403, 'open-in-app/remote-disabled', '远程访问时不能启动宿主机应用')
      return true
    }
    const body = await readJson(req)
    const app = typeof body.app === 'string' ? body.app : ''
    const dir = typeof body.path === 'string' ? body.path : ''
    if (dir === '' || !path.isAbsolute(dir)) {
      apiError(res, 400, 'open-in-app/bad-path', 'path 必须是绝对路径')
      return true
    }
    let stat: fs.Stats | null = null
    try {
      stat = fs.statSync(dir)
    } catch {
      stat = null
    }
    if (!stat?.isDirectory()) {
      apiError(res, 404, 'open-in-app/dir-not-found', `目录不存在:${dir}`)
      return true
    }
    const outcome = await launchApp(app, dir)
    if (outcome === 'unknown') {
      apiError(res, 400, 'open-in-app/unknown-app', `未知或不可用的应用:${app}`)
      return true
    }
    if (outcome === 'failed') {
      apiError(res, 502, 'open-in-app/launch-failed', `启动失败:${app}`)
      return true
    }
    json(res, 200, { ok: true })
    return true
  }
  if (pathname === '/api/open-in-app/apps' && method === 'GET') {
    json(res, 200, { apps: ctx.localOnly ? availableApps() : [] })
    return true
  }
  if (pathname === '/api/browser/state' && method === 'GET') {
    if (!ctx.browser) {
      json(res, 200, { running: false, activeTabId: null, tabs: [] })
      return true
    }
    json(res, 200, await ctx.browser.state())
    return true
  }
  if (pathname === '/api/browser/command' && method === 'POST') {
    if (!ctx.browser) {
      json(res, 200, {
        ok: false,
        error: { code: 'unavailable', message: '当前部署没有启用浏览器' },
        elapsedMs: 0,
      })
      return true
    }
    const body = await readJson(req)
    const command = body.command
    if (typeof command !== 'object' || command === null || Array.isArray(command)) {
      json(res, 200, {
        ok: false,
        error: { code: 'invalid-argument', message: '请求体需要 { command: { method } }' },
        elapsedMs: 0,
      })
      return true
    }
    json(res, 200, await ctx.browser.execute(command as Record<string, unknown>))
    return true
  }
  if (pathname === '/api/browser/stream' && method === 'GET') {
    if (!ctx.browser) {
      apiError(res, 503, 'browser/unavailable', '当前部署没有启用浏览器')
      return true
    }
    res.writeHead(200, sseHeaders())
    res.write('retry: 1000\n\n')
    const unsubscribe = ctx.browser.subscribe((event) => writeSse(res, event))
    const heartbeat = setInterval(() => writeSse(res, { type: 'hb' }), HEARTBEAT_MS)
    heartbeat.unref?.()
    req.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
    return true
  }
  if (pathname === '/api/channels/weixin' && method === 'GET') {
    json(res, 200, emptyWeixinStatus())
    return true
  }
  if (pathname === '/api/channels/qqbot' && method === 'GET') {
    json(res, 200, emptyQqbotStatus())
    return true
  }
  if (pathname === '/api/usage' && method === 'GET') {
    const requested = url.searchParams.get('range')
    if (requested !== null && !isUsageRange(requested)) {
      apiError(res, 400, 'usage/bad-range', `未知的统计区间: ${requested}`)
      return true
    }
    json(res, 200, ctx.usage.snapshot(requested ?? '30d'))
    return true
  }
  if (pathname === '/api/update/check' && method === 'GET') {
    const force = url.searchParams.get('force') === 'true'
    try {
      json(res, 200, await ctx.updater.check(force))
    } catch (error) {
      apiError(res, 502, 'update/check-failed', errorMessage(error))
    }
    return true
  }
  if (pathname === '/api/update/status' && method === 'GET') {
    json(res, 200, ctx.updater.status())
    return true
  }
  if (pathname === '/api/update/install' && method === 'POST') {
    const body = await readJson(req)
    const version = typeof body.version === 'string' ? body.version : ''
    if (!version) {
      apiError(res, 400, 'update/bad-version', '缺少目标版本')
      return true
    }
    try {
      json(res, 200, await ctx.updater.install(version))
    } catch (error) {
      apiError(res, 502, 'update/install-failed', errorMessage(error))
    }
    return true
  }

  const gitFailure = (error: unknown): void => {
    if (error instanceof GitError) apiError(res, error.status, error.code, error.message)
    else apiError(res, 500, 'git/internal', errorMessage(error))
  }
  if (pathname === '/api/git/status' && method === 'GET') {
    try {
      json(res, 200, await gitStatus(url.searchParams.get('path') ?? ''))
    } catch (error) {
      gitFailure(error)
    }
    return true
  }
  if (pathname === '/api/git/diff' && method === 'GET') {
    const source = url.searchParams.get('source')
    try {
      json(
        res,
        200,
        await gitDiff(
          url.searchParams.get('path') ?? '',
          url.searchParams.get('file') ?? '',
          source === 'staged' || source === 'branch' ? source : 'unstaged',
        ),
      )
    } catch (error) {
      gitFailure(error)
    }
    return true
  }
  if (pathname === '/api/git/commit' && method === 'POST') {
    const body = await readJson(req)
    try {
      const result = await gitCommit(
        typeof body.path === 'string' ? body.path : '',
        typeof body.message === 'string' ? body.message : '',
      )
      ctx.broadcast({ type: 'sessions-updated' })
      json(res, 200, result)
    } catch (error) {
      gitFailure(error)
    }
    return true
  }
  if (pathname === '/api/git/push' && method === 'POST') {
    const body = await readJson(req)
    try {
      json(res, 200, await gitPush(typeof body.path === 'string' ? body.path : ''))
    } catch (error) {
      gitFailure(error)
    }
    return true
  }
  if (pathname === '/api/git/commit-message' && method === 'POST') {
    const body = await readJson(req)
    const providerId = typeof body.provider === 'string' ? body.provider : ''
    const modelId = typeof body.model === 'string' ? body.model : ''
    const provider = findProvider(ctx.config(), providerId)
    if (!provider) {
      apiError(res, 400, 'git/unknown-provider', `未知的模型提供商:${providerId}`)
      return true
    }
    try {
      const context = await gitCommitContext(typeof body.path === 'string' ? body.path : '')
      const parts: string[] = []
      for await (const chunk of streamFor({
        provider,
        model: modelId,
        system:
          '你是一个 Git 提交信息生成器。根据用户给出的改动内容与近期提交历史,生成**一条**提交信息。\n\n严格遵守以下格式:\ntype(scope): 描述\n\n要求:\n1. type 取 feat / fix / refactor / perf / docs / test / chore / style / build / ci 之一。\n2. scope 必须是近期提交历史里出现过的模块名;无法判断时省略括号。\n3. 描述用中文,动宾结构,不超过 50 字。\n4. 只输出提交信息本身,不要解释、不要代码块、不要引号。',
        messages: [
          {
            role: 'user',
            content: `近期提交历史:\n${context.log || '(无)'}\n\n当前改动:\n${context.diff || '(无)'}`,
          },
        ],
        tools: [],
        ...(typeof body.reasoning_effort === 'string'
          ? { reasoningEffort: body.reasoning_effort }
          : {}),
        signal: AbortSignal.timeout(120_000),
      })) {
        if (chunk.type === 'text-delta') parts.push(chunk.text)
      }
      json(res, 200, { message: parts.join('').trim() })
    } catch (error) {
      gitFailure(error)
    }
    return true
  }

  return false
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
