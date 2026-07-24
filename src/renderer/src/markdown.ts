// A small, safe Markdown-to-DOM renderer. It builds real nodes with
// textContent (never innerHTML), so agent output can never inject markup.
// Covers the constructs coding agents actually emit: headings, fenced code,
// inline code, bold/italic, links, lists, blockquotes, tables, and rules.

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]]+\]\([^)]+\))/

function inlineToNodes(text: string, target: Node): void {
  let rest = text
  while (rest) {
    const match = INLINE.exec(rest)
    if (!match) { target.appendChild(document.createTextNode(rest)); break }
    if (match.index > 0) target.appendChild(document.createTextNode(rest.slice(0, match.index)))
    const token = match[0]
    if (token.startsWith('`')) {
      const code = document.createElement('code'); code.className = 'md-code-inline'
      code.textContent = token.slice(1, -1); target.appendChild(code)
    } else if (token.startsWith('**') || token.startsWith('__')) {
      const strong = document.createElement('strong'); inlineToNodes(token.slice(2, -2), strong); target.appendChild(strong)
    } else if (token.startsWith('[')) {
      const parts = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)
      if (parts) {
        // Rendered as non-navigating text (the app must not leave its own page);
        // the URL is available on hover.
        const link = document.createElement('span'); link.className = 'md-link'; link.title = parts[2]
        inlineToNodes(parts[1], link); target.appendChild(link)
      } else target.appendChild(document.createTextNode(token))
    } else {
      const em = document.createElement('em'); inlineToNodes(token.slice(1, -1), em); target.appendChild(em)
    }
    rest = rest.slice(match.index + token.length)
  }
}

function paragraph(lines: string[]): HTMLElement {
  const p = document.createElement('p'); p.className = 'md-p'
  lines.forEach((line, index) => {
    if (index > 0) p.appendChild(document.createElement('br'))
    inlineToNodes(line, p)
  })
  return p
}

function codeBlock(lang: string, code: string): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'md-code'
  const head = document.createElement('div'); head.className = 'md-code-head'
  const label = document.createElement('span'); label.textContent = lang || 'text'
  const copy = document.createElement('button'); copy.className = 'md-copy'; copy.textContent = 'Copy'
  copy.addEventListener('click', () => {
    void navigator.clipboard?.writeText(code).then(
      () => { copy.textContent = 'Copied'; setTimeout(() => { copy.textContent = 'Copy' }, 1200) },
      () => { copy.textContent = 'Copy failed' }
    )
  })
  head.append(label, copy)
  const pre = document.createElement('pre'); pre.className = 'md-pre'
  const codeEl = document.createElement('code'); codeEl.textContent = code
  pre.appendChild(codeEl)
  wrap.append(head, pre)
  return wrap
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
}

function tableCells(line: string): string[] {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim())
}

function table(header: string, rows: string[]): HTMLElement {
  const el = document.createElement('table'); el.className = 'md-table'
  const thead = document.createElement('thead'); const htr = document.createElement('tr')
  for (const cell of tableCells(header)) { const th = document.createElement('th'); inlineToNodes(cell, th); htr.appendChild(th) }
  thead.appendChild(htr); el.appendChild(thead)
  const tbody = document.createElement('tbody')
  for (const row of rows) {
    const tr = document.createElement('tr')
    for (const cell of tableCells(row)) { const td = document.createElement('td'); inlineToNodes(cell, td); tr.appendChild(td) }
    tbody.appendChild(tr)
  }
  el.appendChild(tbody); return el
}

export function renderMarkdown(source: string): DocumentFragment {
  const fragment = document.createDocumentFragment()
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let i = 0
  let para: string[] = []
  const flush = (): void => { if (para.length) { fragment.appendChild(paragraph(para)); para = [] } }

  while (i < lines.length) {
    const line = lines[i]

    const fence = /^```(.*)$/.exec(line)
    if (fence) {
      flush()
      const lang = fence[1].trim(); const body: string[] = []
      i += 1
      while (i < lines.length && !/^```/.test(lines[i])) { body.push(lines[i]); i += 1 }
      i += 1
      fragment.appendChild(codeBlock(lang, body.join('\n')))
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      flush()
      const h = document.createElement(`h${heading[1].length}`); h.className = 'md-h'
      inlineToNodes(heading[2], h); fragment.appendChild(h); i += 1; continue
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush(); fragment.appendChild(document.createElement('hr')); i += 1; continue
    }

    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flush()
      const header = line; const rows: string[] = []
      i += 2
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) { rows.push(lines[i]); i += 1 }
      fragment.appendChild(table(header, rows)); continue
    }

    if (/^>\s?/.test(line)) {
      flush()
      const quote: string[] = []
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i += 1 }
      const bq = document.createElement('blockquote'); bq.className = 'md-quote'
      bq.appendChild(paragraph(quote)); fragment.appendChild(bq); continue
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush()
      const ordered = /^\s*\d+[.)]\s+/.test(line)
      const list = document.createElement(ordered ? 'ol' : 'ul'); list.className = 'md-list'
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const item = document.createElement('li')
        inlineToNodes(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ''), item)
        list.appendChild(item); i += 1
      }
      fragment.appendChild(list); continue
    }

    if (!line.trim()) { flush(); i += 1; continue }

    para.push(line); i += 1
  }
  flush()
  return fragment
}
