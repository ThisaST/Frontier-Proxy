import { readFileSync } from 'node:fs'
const css = readFileSync('tokens.css','utf8')
const blocks = [...css.matchAll(/\.app\[data-family="(\w+)"\]\[data-scheme="(\w+)"\]\s*\{([^}]+)\}/g)]
const hex = s => { const m = s.match(/#([0-9a-f]{6})/i); return m ? m[1] : null }
const lum = h => { const c = [0,2,4].map(i => parseInt(h.slice(i,i+2),16)/255).map(v => v <= 0.03928 ? v/12.92 : ((v+0.055)/1.055)**2.4); return 0.2126*c[0]+0.7152*c[1]+0.0722*c[2] }
const ratio = (a,b) => { const [l1,l2] = [lum(a),lum(b)].sort((x,y)=>y-x); return (l1+0.05)/(l2+0.05) }
const pairs = [['fg','surface',4.5],['fg-muted','surface',4.5],['fg-faint','surface',4.5],['accent','surface',4.5],["accent-fg","accent-fill",4.5],['ok','surface',4.5],['warn','surface',4.5],['danger','surface',4.5],['info','surface',4.5],['fg','bg',4.5],['fg-muted','bg',4.5],['fg-muted','surface-2',4.5],['ok','ok-soft',4.5],['warn','warn-soft',4.5],['danger','danger-soft',4.5],['accent','accent-soft',4.5],['diff-add-fg','diff-add',4.5],['diff-del-fg','diff-del',4.5]]
for (const [,fam,scheme,body] of blocks) {
  const t = {}; for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) t[m[1]] = m[2].trim()
  const bad = []
  for (const [a,b,min] of pairs) { const ha = hex(t[a]||''), hb = hex(t[b]||''); if (!ha||!hb) { bad.push(`${a}/${b}: non-hex (${t[a]} on ${t[b]})`); continue } const r = ratio(ha,hb); if (r < min) bad.push(`${a}/${b}: ${r.toFixed(2)} < ${min}`) }
  console.log(`${fam}/${scheme}: ${bad.length ? bad.join('; ') : 'all pass'}`)
}
