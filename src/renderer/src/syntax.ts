import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, definition] of Object.entries({ bash, c, cpp, csharp, css, go, ini, java, javascript, json, markdown, php, python, ruby, rust, scss, sql, swift, typescript, xml, yaml })) {
  hljs.registerLanguage(name, definition)
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

export function highlightSourceLine(source: string, language: string): string {
  if (!source) return '&nbsp;'
  if (!hljs.getLanguage(language)) return escapeHtml(source)
  return hljs.highlight(source, { language, ignoreIllegals: true }).value || '&nbsp;'
}

export type DiffLineKind = 'context' | 'addition' | 'deletion' | 'hunk' | 'header'

export interface DiffLine {
  kind: DiffLineKind
  oldNumber?: number
  newNumber?: number
  marker: string
  source: string
}

export function parseUnifiedDiff(diff: string): DiffLine[] {
  let oldNumber = 0
  let newNumber = 0
  const result: DiffLine[] = []
  for (const line of diff.replace(/\r\n/g, '\n').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldNumber = Number(hunk[1]); newNumber = Number(hunk[2])
      result.push({ kind: 'hunk', marker: '', source: line }); continue
    }
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) {
      result.push({ kind: 'header', marker: '', source: line }); continue
    }
    if (line.startsWith('+')) {
      result.push({ kind: 'addition', newNumber, marker: '+', source: line.slice(1) }); newNumber += 1; continue
    }
    if (line.startsWith('-')) {
      result.push({ kind: 'deletion', oldNumber, marker: '-', source: line.slice(1) }); oldNumber += 1; continue
    }
    const source = line.startsWith(' ') ? line.slice(1) : line
    result.push({ kind: 'context', oldNumber: oldNumber || undefined, newNumber: newNumber || undefined, marker: ' ', source })
    if (oldNumber) oldNumber += 1
    if (newNumber) newNumber += 1
  }
  return result
}
