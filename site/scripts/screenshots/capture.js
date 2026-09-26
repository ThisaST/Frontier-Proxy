const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')
const OUT = join(__dirname, 'out'), URL = 'http://127.0.0.1:8767/app/index.html'
const CWD = '/Users/Shared/demo/todo-api'
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const nav = (v) => `document.querySelector('.nav-item[data-view="${v}"]').click()`
const shots = [
  ['home', `${nav('home')}; await w(300); const p=document.getElementById('home-prompt'); p.value='Add refresh-token rotation to the auth service and cover it with tests'; p.dispatchEvent(new Event('input',{bubbles:true})); await w(900)`],
  ['tasks', `${nav('tasks')}; await w(300); [...document.querySelectorAll('#task-list .task-row')].find(r=>/refresh-token/.test(r.textContent))?.click(); await w(300); const d=[...document.querySelectorAll('#task-inspector button')].find(b=>/details/i.test(b.textContent)); d?.click(); await w(300)`],
  ['routing', `${nav('routing')}; await w(400); document.querySelector('main')?.scrollTo(0,0)`],
  ['agents', `${nav('agents')}; await w(400)`],
  ['agent-drawer', `${nav('agents')}; await w(300); document.querySelectorAll('#agents-view tbody tr')[0]?.click(); await w(500)`],
  ['review', `document.getElementById('agent-drawer')?.close(); ${nav('review')}; await w(500); document.querySelector('#review-view [data-branch], #review-view .review-branch, #review-view li button, #review-view .branch-row')?.click(); await w(600)`]
]
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1440, height: 900, useContentSize: true, show: true, backgroundColor: '#0b0d0c' })
  for (const theme of ['console', 'daylight']) {
    await win.loadURL('about:blank')
    await win.loadURL(URL)
    await win.webContents.executeJavaScript(`localStorage.clear(); localStorage.setItem('fp-theme','${theme}'); localStorage.setItem('fp-current-project','${CWD}'); localStorage.setItem('fp-projects', JSON.stringify(['${CWD}'])); localStorage.setItem('fp-sidebar-collapsed','false'); localStorage.setItem('fp-agents-guide-dismissed','true'); 1`)
    await win.loadURL(URL)
    await wait(1500)
    for (const [name, script] of shots) {
      await win.webContents.executeJavaScript(`(async () => { const w = (ms) => new Promise(r => setTimeout(r, ms)); ${script}; return 1 })()`)
      await wait(700)
      const img = await win.webContents.capturePage()
      writeFileSync(join(OUT, `${name}-${theme}.png`), img.toPNG())
      console.log('shot', name, theme, img.getSize())
    }
  }
  const errs = await win.webContents.executeJavaScript('JSON.stringify(window.__errs || [])')
  console.log('done', errs)
  app.quit()
})
