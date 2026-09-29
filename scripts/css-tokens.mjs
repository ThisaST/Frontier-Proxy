// A deliberately small CSS custom-property resolver for src/renderer/src/styles/tokens.css:
// enough cascade (specificity, then source order) and var() substitution to answer "what does
// `--x` resolve to on <html> with these attributes?". Shared by check-contrast.mjs and the
// token tests, so the two cannot disagree. Handles only what tokens.css uses: `:root`,
// `:is(:root, .app)` and attribute selectors on it.

function splitTop(text, sep) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === sep && depth === 0) { parts.push(text.slice(start, i)); start = i + 1 }
  }
  parts.push(text.slice(start))
  return parts.map((part) => part.trim()).filter(Boolean)
}

// `:root` / `:is(:root, .app)` followed by attribute conditions, `[a]` / `[a='v']`, and
// `:where(:not([a]))` (an absence test with no specificity). Anything else can never match <html>.
const PART = String.raw`\[([\w-]+)(?:=(?:'([^']*)'|"([^"]*)"))?\]|:where\(:not\(\[([\w-]+)\]\)\)`
function compound(selector) {
  const match = new RegExp(String.raw`^(?::root|:is\(:root,\s*\.app\))((?:${PART})*)$`).exec(selector.replace(/\s+/g, ' '))
  if (!match) return { specificity: 0, attrs: null }
  // attrs entries: [name, value | undefined, absent]
  const attrs = [...match[1].matchAll(new RegExp(PART, 'g'))].map((m) => m[4] ? [m[4], undefined, true] : [m[1], m[2] ?? m[3], false])
  return { specificity: 1 + attrs.filter((attr) => !attr[2]).length, attrs }
}

/** One entry per selector in a rule list: { selector, specificity, attrs, order, decls: { '--x': 'value' } }. */
export function parseRules(css) {
  const rules = []
  let order = 0
  for (const [, selectorText, body] of css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = {}
    for (const decl of splitTop(body, ';')) {
      const at = decl.indexOf(':')
      const name = decl.slice(0, at).trim()
      if (name.startsWith('--')) decls[name] = decl.slice(at + 1).trim().replace(/\s+/g, ' ')
    }
    for (const selector of splitTop(selectorText, ',')) rules.push({ selector, ...compound(selector), order: order++, decls })
  }
  return rules
}

/** Every custom property that applies to <html> carrying `attrs` (e.g. { 'data-family': 'phosphor' }), var() resolved. */
export function resolveTokens(rules, attrs = {}) {
  const raw = new Map()
  const applicable = rules
    .filter((rule) => rule.attrs && rule.attrs.every(([name, value, absent]) => absent ? !(name in attrs) : name in attrs && (value === undefined || attrs[name] === value)))
    .sort((a, b) => a.specificity - b.specificity || a.order - b.order)
  for (const rule of applicable) for (const [name, value] of Object.entries(rule.decls)) raw.set(name, value)
  const resolve = (value, seen) => value.replace(/var\((--[\w-]+)\s*(?:,\s*([^)]*))?\)/g, (_, name, fallback) => {
    if (seen.includes(name)) throw new Error(`circular custom property: ${[...seen, name].join(' -> ')}`)
    if (raw.has(name)) return resolve(raw.get(name), [...seen, name])
    if (fallback !== undefined) return fallback.trim()
    throw new Error(`undefined custom property ${name} (used by ${seen.at(-1) ?? 'a token'})`)
  })
  return Object.fromEntries([...raw].map(([name, value]) => [name, resolve(value, [name])]))
}
