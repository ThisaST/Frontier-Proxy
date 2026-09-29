// Re-shoots site/src/assets/screens/*.png: the real built renderer (out/renderer) against the
// canned fixture in demo.js, in both schemes of the Neutral family. Nothing of the developer's own
// state is read: `window.frontier` is a stub (demo.js), and the project shown is a made-up path.
//
//   pnpm build                                              # at the repo root, so out/renderer exists
//   ./node_modules/.bin/electron site/scripts/screenshots/capture.js
//
// It serves out/renderer itself (with the CSP meta dropped and demo.js injected ahead of the
// bundle, which reads the bridge at import time), so no other server or profile is needed.
process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true' // the harness page has no CSP on purpose
import { app, BrowserWindow } from 'electron'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

// site/package.json is "type": "module", so this is ESM (Electron runs it as the main script).
const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = join(HERE, '..', '..', '..')
const RENDERER = join(ROOT, 'out', 'renderer')
const OUT = join(HERE, '..', '..', 'src', 'assets', 'screens')
const CWD = '/Users/Shared/demo/todo-api'
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png' }
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The docs and landing page use these names (site/src/lib/screens.ts).
const click = (selector) => `document.querySelector(${JSON.stringify(selector)})?.click()`
const nav = (view) => click(`.nav-item[data-view="${view}"]`)
const SHOTS = [
  // Tasks in compose state, with a prompt typed so the one-line route preview is filled in.
  ['tasks-compose', `${nav('tasks')}; await w(300); const p = document.getElementById('compose-prompt'); p.value = 'Add refresh-token rotation to the auth service and cover it with tests'; p.dispatchEvent(new Event('input', { bubbles: true })); await w(1000)`],
  // Tasks with a finished task selected: conversation, and the route/files/activity inspector.
  ['tasks', `${nav('tasks')}; await w(300); [...document.querySelectorAll('#task-list .task-row')].find((row) => /refresh-token/.test(row.textContent))?.click(); await w(500)`],
  ['workspaces', `${nav('workspace')}; await w(700)`],
  ['review', `${nav('review')}; await w(600); ${click('#review-list .review-branch')}; await w(700)`],
  ['agents', `${nav('agents')}; await w(600)`],
  ['settings-appearance', `${nav('settings')}; await w(300); ${click('[data-settings-tab="appearance"]')}; await w(500)`]
]

// index.html as the harness serves it: without the CSP meta (a localhost origin on a random port
// would otherwise need connect-src for nothing), and with demo.js ahead of the module bundle.
function page() {
  return readFileSync(join(RENDERER, 'index.html'), 'utf8')
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<script type="module"', '<script src="/demo.js"></script><script type="module"')
}

function serve() {
  const server = createServer((request, response) => {
    const path = normalize(decodeURIComponent(new URL(request.url, 'http://x').pathname)).replace(/^([/\\])+/, '')
    if (path === '' || path === 'index.html') { response.writeHead(200, { 'content-type': 'text/html' }); response.end(page()); return }
    const file = path === 'demo.js' ? join(HERE, 'demo.js') : join(RENDERER, path)
    if (!(file.startsWith(HERE) || file.startsWith(RENDERER)) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
    response.end(readFileSync(file))
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

app.whenReady().then(async () => {
  if (!existsSync(join(RENDERER, 'index.html'))) throw new Error('out/renderer is missing: run `pnpm build` at the repo root first')
  mkdirSync(OUT, { recursive: true })
  const server = await serve()
  const url = `http://127.0.0.1:${server.address().port}/`
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: false, webPreferences: { backgroundThrottling: false } })
  const problems = []
  win.webContents.on('console-message', ({ level, message }) => { if (level === 'error') problems.push(message) })
  for (const scheme of ['light', 'dark']) {
    console.log('loading', scheme)
    await win.loadURL('about:blank')
    await win.loadURL(url)
    // Appearance keys as theme-model.ts reads them; `fp-agents-setup-dismissed` hides the Agents
    // screen's getting-started notice; the project keys pick the fixture's repo.
    await win.webContents.executeJavaScript(`localStorage.clear()
      localStorage.setItem('fp-family', 'neutral'); localStorage.setItem('fp-scheme', '${scheme}')
      localStorage.setItem('fp-current-project', '${CWD}'); localStorage.setItem('fp-projects', JSON.stringify(['${CWD}']))
      localStorage.setItem('fp-agents-setup-dismissed', 'true'); 1`)
    await win.loadURL(url)
    await wait(1500)
    for (const [name, script] of SHOTS) {
      await win.webContents.executeJavaScript(`(async () => { const w = (ms) => new Promise((resolve) => setTimeout(resolve, ms)); ${script}; return 1 })()`)
      await wait(700)
      // A 1440x900 window captures at the display's scale (2x on Retina); the site serves at most 1920 wide.
      const captured = await win.webContents.capturePage()
      const image = captured.getSize().width > 1920 ? captured.resize({ width: 1920, quality: 'best' }) : captured
      writeFileSync(join(OUT, `${name}-${scheme}.png`), image.toPNG())
      console.log('shot', name, scheme, image.getSize())
    }
  }
  console.log(problems.length ? `console problems:\n${problems.join('\n')}` : 'no console errors')
  server.close()
  app.quit()
}).catch((error) => { console.error(error); app.exit(1) })
