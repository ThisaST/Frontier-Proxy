import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// Dev only: Vite injects CSS as an inline <style> tag, which the renderer's
// `style-src 'self'` blocks — the app renders unstyled under `pnpm dev`. The
// built app links a real stylesheet, so production keeps the strict policy.
const devStyleCsp: Plugin = {
  name: 'frontier-dev-style-csp',
  apply: 'serve',
  transformIndexHtml: (html) => html.replace("style-src 'self'", "style-src 'self' 'unsafe-inline'")
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: { input: resolve('src/main/index.ts') } }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [devStyleCsp],
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
