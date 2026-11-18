import { defineConfig, loadEnv } from 'vite'

// This file runs in Node, but the web tsconfig intentionally excludes Node
// globals; declare only the slice used here.
declare const process: { env: Record<string, string | undefined> }

/**
 * 开发服务器:控制台用相对路径 /api 访问服务端。
 * 生产环境由服务端同源提供,开发时若不代理,/api 会落到 Vite 的 SPA 回退返回 index.html。
 * 端口与代理目标可由 DENIA_VITE_PORT / DENIA_API_URL 覆盖;`npm run dev`
 * (electron/scripts/dev.mjs) 会注入与宿主一致的值。
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', 'DENIA_')
  const apiTarget =
    process.env.DENIA_API_URL?.trim() ||
    env.DENIA_API_URL?.trim() ||
    'http://127.0.0.1:43655'
  const port = Number(process.env.DENIA_VITE_PORT || env.DENIA_VITE_PORT || 5173)
  return {
    server: {
      port,
      strictPort: true,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          ws: true,
        },
      },
    },
  }
})