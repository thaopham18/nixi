// Hides secrets in terminal text before it leaves this computer for an AI provider. Best effort:
// it catches the common shapes, and the user sees the result before anything is sent.

export const MASK = '[hidden]'

/** Text worth treating as a saved secret: short values like "test" would hide ordinary words. */
const MIN_KNOWN_LENGTH = 6

// Order matters: whole blocks first, then values after a keyword.
const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, MASK],
  // The top of the key scrolled off: everything before its last line is key.
  [/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{16,}\b/g, MASK],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MASK],
  // https://user:pass@host, mysql://user:pass@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(@)/gi, `$1${MASK}$2`],
  [/\b((?:proxy-)?authorization\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi, `$1${MASK}`],
  [/\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, `$1${MASK}`],
  // password=x, "api_key": "x", client-secret: x
  [
    /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9]+[_-])*(?:password|passwd|pwd|passphrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"',;&]+)/gi,
    `$1${MASK}`
  ],
  // mysql -uroot -pSecret (not -p 3306, where the value is a separate word and may be a port)
  [/(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^\n]*?\s-p)(?=[^\s-])[^\s]+/gi, `$1${MASK}`],
  [/(\bsshpass\s+-p\s*)[^\s]+/gi, `$1${MASK}`],
  [/(--password[= ]\s*)[^\s]+/gi, `$1${MASK}`]
]

/** Mask secrets in `text`; `known` holds exact values, such as the passwords saved in the database. */
export function redact(text: string, known: readonly string[] = []): string {
  let out = text
  // Longest first, so a password containing another one is hidden whole.
  const values = [...new Set(known)].filter((k) => k.length >= MIN_KNOWN_LENGTH).sort((a, b) => b.length - a.length)
  for (const value of values) out = out.split(value).join(MASK)
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement)
  return out
}

/** Keep the last `max` lines: the newest output is what a question is about. */
export function lastLines(text: string, max: number): { text: string; dropped: number } {
  const lines = text.split('\n')
  if (lines.length <= max) return { text, dropped: 0 }
  return { text: lines.slice(-max).join('\n'), dropped: lines.length - max }
}
