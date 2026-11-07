// Incremental SSE parser shared by every protocol.
//
// All three provider APIs stream `data:` payloads separated by blank lines;
// Anthropic additionally sends `event:` lines, which the caller can ignore
// because the JSON payload carries its own `type`.

export async function* ssePayloads(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      for (;;) {
        const boundary = buffer.indexOf('\n\n')
        if (boundary < 0) break
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data: string[] = []
        for (const rawLine of block.split('\n')) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
          if (!line.startsWith('data:')) continue
          data.push(line.slice(5).trimStart())
        }
        if (data.length > 0) yield data.join('\n')
      }
    }
    const tail = buffer.trim()
    if (tail.startsWith('data:')) yield tail.slice(5).trimStart()
  } finally {
    reader.releaseLock()
  }
}

export async function readErrorBody(response: Response): Promise<{ message: string; code?: string }> {
  const fallback = { message: response.statusText || `HTTP ${response.status}` }
  try {
    const text = await response.text()
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string; type?: string }
      message?: string
    }
    if (parsed.error?.message) {
      return { message: parsed.error.message, code: parsed.error.code ?? parsed.error.type }
    }
    if (typeof parsed.message === 'string') return { message: parsed.message }
  } catch {
    /* non-JSON body */
  }
  return fallback
}