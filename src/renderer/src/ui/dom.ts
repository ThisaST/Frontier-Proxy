// Generic DOM element builders shared across views. No app state.
import { highlightSourceLine, parseUnifiedDiff } from '../syntax'

export const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

export function element(tag: string, className?: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function emptyState(title: string, detail: string): HTMLElement {
  const empty = element('div', 'empty-state')
  empty.append(element('strong', undefined, title), detail)
  return empty
}

export function field(labelText: string, input: HTMLElement, wide = false): HTMLLabelElement {
  const label = document.createElement('label'); if (wide) label.className = 'wide'
  label.append(labelText, input); return label
}

export function textInput(value: string, type = 'text'): HTMLInputElement {
  const input = document.createElement('input'); input.type = type; input.value = value; return input
}

export function textArea(value: string, rows = 2): HTMLTextAreaElement {
  const area = document.createElement('textarea'); area.rows = rows; area.value = value; return area
}

export function metaChip(label: string, value: string, className = ''): HTMLElement {
  const chip = element('div', `meta-chip ${className}`.trim())
  chip.append(element('span', 'meta-label', label), element('strong', undefined, value))
  return chip
}

export function gauge(percent: number | undefined, tone = ''): HTMLElement {
  const bar = element('div', `home-bar ${tone}`.trim())
  const fill = element('div')
  fill.style.width = `${Math.min(100, Math.max(0, percent ?? 0))}%`
  bar.append(fill)
  return bar
}

// Diff/source code line rendering, shared by the task Files tab and the Review
// branch diff viewer.
export function codeLine(oldNumber: number | undefined, newNumber: number | undefined, marker: string, source: string, kind: string, language: string): HTMLElement {
  const row = element('div', `task-code-line ${kind}`)
  const old = element('span', 'task-code-number', oldNumber ? String(oldNumber) : '')
  const next = element('span', 'task-code-number', newNumber ? String(newNumber) : '')
  const mark = element('span', 'task-code-marker', marker)
  const code = document.createElement('code')
  // highlight.js escapes source text and emits only span markup for token classes.
  code.innerHTML = highlightSourceLine(source, language)
  row.append(old, next, mark, code); return row
}

export function renderDiffInto(container: HTMLElement, diff: string, language: string): void {
  container.replaceChildren(...parseUnifiedDiff(diff).map((line) => {
    if (line.kind === 'header' || line.kind === 'hunk') {
      const row = element('div', `task-code-line ${line.kind}`)
      const text = document.createElement('code'); text.textContent = line.source; row.append(text); return row
    }
    return codeLine(line.oldNumber, line.newNumber, line.marker, line.source, line.kind, language)
  }))
}
