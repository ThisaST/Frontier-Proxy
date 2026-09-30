import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

// The version shown in the UI comes from package.json at build time, so the
// release PR's `changeset version` bump is the only edit a release needs.
const appVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version
const injectAppVersion: Plugin = {
  name: 'frontier-app-version',
  transformIndexHtml: (html) => html.replaceAll('%APP_VERSION%', appVersion)
}

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
    plugins: [devStyleCsp, injectAppVersion],
    // Every asset stays a file: Vite would otherwise inline the small @fontsource subsets as
    // `data:` URLs, which `default-src 'self'` blocks (fonts fall under it; only img-src allows data:).
    build: { assetsInlineLimit: 0, rollupOptions: { input: resolve('src/renderer/index.html') } }
  }
})
