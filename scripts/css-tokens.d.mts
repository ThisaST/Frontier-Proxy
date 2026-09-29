export interface Rule { selector: string; specificity: number; order: number; attrs: [string, string | undefined, boolean][] | null; decls: Record<string, string> }
export function parseRules(css: string): Rule[]
export function resolveTokens(rules: Rule[], attrs?: Record<string, string>): Record<string, string>
