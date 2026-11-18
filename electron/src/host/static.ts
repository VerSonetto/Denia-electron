import fs from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'

import { isDirectory, mimeOf } from './http.ts'

/**
 * 静态资源下发。
 *
 * 构建期已经给每个文本产物旁挂了 `.br` / `.gz`（wq11 Brotli，控制台主包
 * 4.7 MB → 0.74 MB），这里只按 `Accept-Encoding` 选现成实体发出去：
 * 运行时零压缩 CPU。不这么做的话，每次启动都要把未压缩的主包从本机 HTTP
 * 搬进渲染进程，多出的几 MB 传输与解析全落在启动的关键路径上。
 */
export function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  webDir: string,
  pathname: string,
): void {
  if (!isDirectory(webDir)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(
      `web UI 构建产物不存在:${webDir}\n请先在 web/ 执行 pnpm install && pnpm build,或用 --web-dir 指定目录。`,
    )
    return
  }
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const resolved = path.resolve(webDir, relative)
  const webRoot = path.resolve(webDir)
  const inside = resolved === webRoot || resolved.startsWith(webRoot + path.sep)
  let file = inside ? resolved : webRoot
  if (!inside) {
    res.writeHead(403)
    res.end('forbidden')
    return
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback only for extension-less routes; missing assets stay 404.
    if (path.extname(relative) !== '') {
      res.writeHead(404)
      res.end('not found')
      return
    }
    file = path.join(webRoot, 'index.html')
    if (!fs.existsSync(file)) {
      res.writeHead(404)
      res.end('index.html missing')
      return
    }
  }
  const precompressed = precompressedFor(req, file)
  const target = precompressed ?? file
  res.writeHead(200, {
    'content-type': mimeOf(file),
    'cache-control': file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    ...(precompressed === null
      ? {}
      : { 'content-encoding': precompressed.endsWith('.br') ? 'br' : 'gzip', vary: 'Accept-Encoding' }),
  })
  fs.createReadStream(target).pipe(res)
}

/**
 * 选一个可用的预压缩实体路径。
 *
 * 只有文本类产物会带旁挂文件（图片/字体自身已压缩，再压一遍没有收益），
 * 所以缺少旁挂文件是常态而不是错误：那时直接发原文件。
 */
function precompressedFor(req: IncomingMessage, file: string): string | null {
  const accepted = req.headers['accept-encoding'] ?? ''
  const candidates: [string, boolean][] = [
    [`${file}.br`, /\bbr\b/.test(accepted)],
    [`${file}.gz`, /\bgzip\b/.test(accepted)],
  ]
  for (const [candidate, usable] of candidates) {
    if (!usable) continue
    try {
      if (fs.statSync(candidate).isFile()) return candidate
    } catch {
      /* 这个产物没有预压缩变体 */
    }
  }
  return null
}
