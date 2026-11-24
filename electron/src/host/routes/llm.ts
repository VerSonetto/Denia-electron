// Model routes: provider listing, catalog, endpoint discovery and streaming
// chat.
//
// `/api/llm/chat` mirrors the old Rust host's contract: chunk frames carry the
// shared `StreamChunk` vocabulary, and an upstream failure after the response
// has started arrives as one named `error` frame. It serves both the prompt
// optimizer and the settings connectivity probe.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { AppConfig } from '../../config.ts'
import { findProvider, loadCredentialRefs } from '../../config.ts'
import { errorMessage, isRecord } from '../../core/util.ts'
import type { ChatMessage, ChatRole } from '../../core/wire.ts'
import { streamFor } from '../../llm/index.ts'
import { LlmRequestError } from '../../llm/types.ts'
import { HEARTBEAT_MS } from '../events.ts'
import { apiError, json, readJson, sseHeaders, writeSse, writeSseEvent } from '../http.ts'

export interface LlmApiContext {
  home: string
  config: () => AppConfig
}

export async function handleLlmApi(
  ctx: LlmApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (pathname === '/api/llm/providers' && method === 'GET') {
    json(res, 200, {
      providers: ctx.config().providers.map((provider) => ({ id: provider.id, name: provider.name })),
      configurable: [],
    })
    return true
  }
  if (pathname === '/api/llm/catalog' && method === 'GET') {
    json(res, 200, {
      routableProviders: ctx.config().providers.map((provider) => provider.id),
      groups: ctx.config().providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          ...(model.description ? { description: model.description } : {}),
          ...(model.contextWindow ?? provider.defaultContextWindow
            ? { contextWindow: model.contextWindow ?? provider.defaultContextWindow }
            : {}),
          ...(model.inputModalities ? { inputModalities: model.inputModalities } : {}),
          ...(model.thinkingSupported ? { thinkingSupported: model.thinkingSupported } : {}),
          ...(model.reasoningEfforts?.some((effort) => effort !== 'off')
            ? {
                reasoning: {
                  efforts: model.reasoningEfforts.map((effort) => ({ id: effort, name: effort })),
                  defaultEffort: model.reasoningEfforts[0],
                },
              }
            : {}),
        })),
      })),
      failures: [],
    })
    return true
  }
  if (pathname === '/api/llm/discover' && method === 'POST') {
    const body = await readJson(req)
    const baseURL = typeof body.baseURL === 'string' ? body.baseURL.trim() : ''
    if (!baseURL) {
      apiError(res, 400, 'llm/bad-base-url', 'baseURL 不能为空')
      return true
    }
    try {
      const headers: Record<string, string> = { accept: 'application/json' }
      let key = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      if (!key && typeof body.apiKeyEnv === 'string' && body.apiKeyEnv.trim()) {
        const ref = body.apiKeyEnv.trim()
        key = process.env[ref]?.trim() || loadCredentialRefs(ctx.home)[ref]?.trim() || ''
      }
      if (key) headers.authorization = `Bearer ${key}`
      const response = await fetch(`${baseURL.replace(/\/+$/, '')}/models`, { headers })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = (await response.json()) as { data?: { id?: string }[] }
      const models = (payload.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => typeof id === 'string')
        .map((id) => ({ id, name: id }))
      json(res, 200, { models })
    } catch (error) {
      apiError(res, 502, 'llm/discover-failed', errorMessage(error))
    }
    return true
  }
  if (pathname === '/api/llm/chat' && method === 'POST') {
    await handleChat(ctx, req, res)
    return true
  }
  return false
}

const CHAT_ROLES: ReadonlySet<string> = new Set(['system', 'user', 'assistant', 'tool'])

/** `messages` wins over the single-prompt convenience field, like the Rust host. */
function chatMessagesOf(body: Record<string, unknown>): ChatMessage[] | null {
  if (Array.isArray(body.messages)) {
    const messages: ChatMessage[] = []
    for (const entry of body.messages) {
      if (!isRecord(entry)) continue
      if (typeof entry.role !== 'string' || !CHAT_ROLES.has(entry.role)) continue
      if (typeof entry.content !== 'string') continue
      messages.push({ role: entry.role as ChatRole, content: entry.content })
    }
    if (messages.length > 0) return messages
  }
  if (typeof body.prompt === 'string' && body.prompt.trim() !== '') {
    return [{ role: 'user', content: body.prompt }]
  }
  return null
}

function failureOf(error: unknown): { code: string; message: string; status?: number } {
  if (error instanceof LlmRequestError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.status === undefined ? {} : { status: error.status }),
    }
  }
  return { code: 'chat/failed', message: errorMessage(error) }
}

async function handleChat(
  ctx: LlmApiContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJson(req)
  const providerId = typeof body.provider === 'string' ? body.provider.trim() : ''
  const modelId = typeof body.model === 'string' ? body.model.trim() : ''
  if (!providerId || !modelId) {
    apiError(res, 400, 'chat/incomplete', 'provider 与 model 不能为空')
    return
  }
  const provider = findProvider(ctx.config(), providerId)
  if (!provider) {
    apiError(res, 400, 'chat/unknown-provider', `未知的模型提供商:${providerId}`)
    return
  }
  const model = provider.models.find((entry) => entry.id === modelId)
  if (!model && provider.models.length > 0) {
    apiError(res, 400, 'chat/unknown-model', `模型 ${modelId} 不在 ${provider.name} 的模型列表中`)
    return
  }
  const reasoningEffort =
    typeof body.reasoningEffort === 'string' && body.reasoningEffort.trim() !== ''
      ? body.reasoningEffort.trim()
      : undefined
  if (
    reasoningEffort &&
    model?.reasoningEfforts &&
    model.reasoningEfforts.length > 0 &&
    !model.reasoningEfforts.includes(reasoningEffort)
  ) {
    apiError(
      res,
      400,
      'chat/unsupported-reasoning-effort',
      `模型 ${modelId} 不支持推理强度 ${reasoningEffort}`,
    )
    return
  }
  const messages = chatMessagesOf(body)
  if (!messages) {
    apiError(res, 400, 'chat/empty', '需要 prompt 或非空的 messages 数组')
    return
  }
  const system = typeof body.system === 'string' && body.system !== '' ? body.system : undefined
  const temperature =
    typeof body.temperature === 'number' && Number.isFinite(body.temperature)
      ? body.temperature
      : undefined
  const rawMaxTokens = body.max_tokens ?? body.maxTokens
  const maxTokens =
    typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
      ? Math.floor(rawMaxTokens)
      : undefined

  // 客户端取消(优化撤销 / 探测超时)必须停掉上游流,不能让它继续计费。
  const controller = new AbortController()
  const onClose = (): void => {
    if (!res.writableEnded) controller.abort()
  }
  res.on('close', onClose)
  res.writeHead(200, sseHeaders())
  const heartbeat = setInterval(() => writeSse(res, { type: 'hb' }), HEARTBEAT_MS)
  heartbeat.unref?.()
  try {
    for await (const chunk of streamFor({
      provider,
      model: modelId,
      messages,
      tools: [],
      signal: controller.signal,
      ...(system === undefined ? {} : { system }),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      ...(temperature === undefined ? {} : { temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })) {
      writeSse(res, chunk)
    }
  } catch (error) {
    // 客户端断开触发的 abort 不是模型失败,不写错误帧。
    if (!controller.signal.aborted) writeSseEvent(res, 'error', failureOf(error))
  } finally {
    clearInterval(heartbeat)
    res.off('close', onClose)
    if (!res.writableEnded) res.end()
  }
}
