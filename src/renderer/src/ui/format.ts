// Generic formatting and text<->structured-data helpers. No DOM, no app state.

export function formatNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: value > 9_999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value)
}

export function timeAgo(date?: string): string {
  if (!date) return '—'
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(date)) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86400)}d ago`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${Math.round(seconds % 60)}s`
}

export function formatCost(usd: number): string {
  if (usd >= 0.005) return `$${usd.toFixed(2)}`
  return usd > 0 ? '<$0.01' : '$0.00'
}

export function countdown(iso?: string): string {
  if (!iso) return '—'
  const ms = Date.parse(iso) - Date.now()
  if (ms <= 0) return 'resetting…'
  const days = Math.floor(ms / 86_400_000)
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (days > 0) return `${days}d ${hours % 24}h`
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/)
  return parts[parts.length - 1] || path
}

export function recordToLines(record: Record<string, string> | undefined, sep: string): string {
  return record ? Object.entries(record).map(([key, value]) => `${key}${sep}${value}`).join('\n') : ''
}

export function linesToRecord(value: string, sep: string): Record<string, string> | undefined {
  const record: Record<string, string> = {}
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim(); if (!trimmed) continue
    const index = trimmed.indexOf(sep); if (index < 0) continue
    const key = trimmed.slice(0, index).trim()
    if (key) record[key] = trimmed.slice(index + sep.length).trim()
  }
  return Object.keys(record).length ? record : undefined
}

export function splitArguments(value: string): string[] {
  const result: string[] = []
  let current = ''
  let quote = ''
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (quote) {
      if (character === quote) quote = ''
      else if (character === '\\' && index + 1 < value.length) current += value[++index]
      else current += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) { if (current) { result.push(current); current = '' } }
    else current += character
  }
  if (current) result.push(current)
  return result
}

export function formatArguments(values: string[]): string {
  return values.map((value) => /\s/.test(value) ? JSON.stringify(value) : value).join(' ')
}

export function listValues(value: string): string[] {
  return [...new Set(value.split(/[\r\n,]+/).map((item) => item.trim()).filter(Boolean))]
}

export function textLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}
