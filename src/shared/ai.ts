import { lastLines, redact } from './redact'

// The AI assistant, the parts both sides share. Nothing here talks to a network.

export type AiProviderId = 'anthropic' | 'gemini' | 'custom'

export interface AiModelInfo {
  id: string
  label?: string
}

export interface AiProviderInfo {
  id: AiProviderId
  label: string
  /** shown until the provider's own list arrives, and when it can't be fetched. The first is the default. */
  models: AiModelInfo[]
  keyHint: string
  keyHelp: string
}

export const AI_PROVIDERS: AiProviderInfo[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' }
    ],
    keyHint: 'sk-ant-…',
    keyHelp: 'Create one at console.anthropic.com, under API keys.'
  },
  {
    id: 'gemini',
    label: 'Gemini',
    models: [{ id: 'gemini-3.8-flash' }, { id: 'gemini-2.5-flash' }],
    keyHint: 'Gemini API key',
    keyHelp: 'Create one at aistudio.google.com, under API keys.'
  },
  {
    id: 'custom',
    label: 'Custom',
    models: [],
    keyHint: 'Leave empty if the server needs none',
    keyHelp: 'Many local servers, such as Ollama and LM Studio, need no key.'
  }
]

export const aiProviderInfo = (id: string | undefined): AiProviderInfo => AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0]

export const GEMINI_API_PATH = '/v1beta/openai'

interface AiChoice {
  aiProvider?: string
  aiModels?: Partial<Record<AiProviderId, string>>
}

/** The model in use: any name the provider takes, so one released after this app still works. */
export function aiModelOf(s: AiChoice | undefined): string {
  const info = aiProviderInfo(s?.aiProvider)
  return s?.aiModels?.[info.id]?.trim() || info.models[0]?.id || ''
}

/** Lists hold models for speech, images and search too, which can't hold a conversation. */
const NOT_CHAT = /embed|tts|whisper|transcri|moderation|dall-e|image|imagen|veo|audio|realtime|live|aqa|rerank|lyria|robotics|computer-use/i

export function chatModelIds(ids: readonly string[]): string[] {
  const names = [...new Set(ids.map((id) => id.replace(/^models\//, '')))]
  const chat = names.filter((id) => !NOT_CHAT.test(id))
  return chat.length ? chat : names
}

const PRIVATE_HOST = /^(?:localhost|.*\.local|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(?:1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\]|\[f[cd][0-9a-f:]*\])$/i

/**
 * Where a custom provider lives, cleaned up. The key and terminal text go there, so plain http is
 * only for this computer and its local network.
 */
export function parseAiBaseUrl(input: string | undefined): { url: string } | { error: string } {
  const text = (input ?? '').trim()
  if (!text) return { error: 'Enter the address of the server.' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { error: 'Enter a full address, such as https://api.openai.com/v1' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'The address must start with https:// or http://' }
  if (url.username || url.password || url.search || url.hash) return { error: 'Put the key in the API key field, not in the address.' }
  if (url.protocol === 'http:' && !PRIVATE_HOST.test(url.hostname)) return { error: 'Plain http would send your key and terminal text unencrypted. Use https://, or a server on your own network.' }
  return { url: (url.origin + url.pathname).replace(/\/+$/, '').replace(/\/chat\/completions$/, '') }
}

export const MAX_ATTACH_LINES = 500
export const MAX_ATTACH_CHARS = 100_000
export const MAX_COMMAND_LENGTH = 4000

export interface Attachment {
  /** after hiding secrets and cutting to size: exactly what the provider receives */
  text: string
  /** lines left out at the top */
  dropped: number
}

/** Secrets are hidden before cutting, so a cut can't split one and let half of it through. */
export function prepareAttachment(raw: string, known: readonly string[] = []): Attachment {
  const hidden = redact(raw, known).replace(/\s+$/, '')
  const cut = lastLines(hidden, MAX_ATTACH_LINES)
  if (cut.text.length <= MAX_ATTACH_CHARS) return cut
  const tail = cut.text.slice(-MAX_ATTACH_CHARS)
  // Start on a whole line when there is one.
  const newline = tail.indexOf('\n')
  const text = newline >= 0 ? tail.slice(newline + 1) : tail
  return { text, dropped: cut.dropped + cut.text.slice(0, cut.text.length - text.length).split('\n').length - 1 }
}

/** Output comes from the server, so it can't be allowed to close the tag and pose as the user. */
export function wrapTerminalOutput(text: string, source?: string): string {
  const body = text.replace(/<(\/?)terminal_output/gi, '&lt;$1terminal_output')
  return `<terminal_output${source ? ` source="${source}"` : ''}>\n${body}\n</terminal_output>`
}

// What the user reads must be what runs: nothing that moves the cursor, submits early or reorders text.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/

export type ParsedProposal = { command: string; reason: string } | { error: string }

/** Tool input arrives unchecked from the model and may be cut short: check it before showing it. */
export function parseProposal(input: unknown): ParsedProposal {
  const { command, reason } = (input ?? {}) as { command?: unknown; reason?: unknown }
  if (typeof command !== 'string' || !command.trim()) return { error: 'command must be a non-empty string' }
  if (typeof reason !== 'string' || !reason.trim()) return { error: 'reason must be a non-empty string' }
  if (command.length > MAX_COMMAND_LENGTH) return { error: `command must be at most ${MAX_COMMAND_LENGTH} characters` }
  if (UNSAFE_CHARS.test(command)) return { error: 'command must be one line, without control or invisible characters' }
  return { command: command.trim(), reason: reason.trim() }
}

const NOT_A_COMMAND_BLOCK = /^(?:text|plaintext|plain|txt|output|log|json|yaml|yml|xml|html|diff|markdown|md)$/i
const COMMAND_WORD = /^(?:[a-z][\w+-]*|\.{1,2}\/\S+|[A-Z][a-z]+-[A-Z]\w*)$/
const PATH_WORD = /^(?:~?\/)\S+$/
// `cat <file>` would run as a redirect, and `ls [dir]` or `tail ...` were never meant literally.
const PLACEHOLDER = /<[^<>]*>|\[[^\]]*\]|\.\.\.|…|\bYOUR_|\byour[-_ ]/

/**
 * A command the answer wrote out in code, for a model that names one without calling the tool. Only ever
 * offered with a Run button: its text can come from what a server printed, so nothing runs by itself.
 */
export function runnableCommand(code: string, language = ''): string | undefined {
  if (NOT_A_COMMAND_BLOCK.test(language.trim())) return undefined
  const line = code.trim().replace(/^\$\s+/, '')
  const parsed = parseProposal({ command: line, reason: 'named in the answer' })
  if ('error' in parsed) return undefined
  if (PLACEHOLDER.test(line)) return undefined
  const [first, ...rest] = line.split(/\s+/)
  // A path alone is a place being talked about; with arguments it is a program.
  return COMMAND_WORD.test(first) || (PATH_WORD.test(first) && rest.length) ? line : undefined
}

/** A program waiting for a secret would take a command as its answer, and may echo it nowhere. */
export function asksForSecret(line: string): boolean {
  return /(?:pass(?:word|phrase|code)|verification code|one-time|\botp\b|\bpin\b)[^\n]*[:?]\s*$/i.test(line)
}

/** A shell or device waiting for input: Enter on an empty line would give another one like it. */
export function looksLikePrompt(line: string): boolean {
  return /[#$%>❯➜]$/.test(line.trim())
}

export interface AiMessageInput {
  text: string
  attachment?: { raw: string; source: 'screen' | 'selection' }
}

export type AiAnswer =
  | { kind: 'skipped' }
  | { kind: 'kept' }
  /** `progress`: known only in automatic mode; without it the user decided when to send */
  | { kind: 'output'; raw: string; progress?: 'finished' | 'running' }

export type AiEvent =
  | { type: 'busy'; on: boolean }
  /** another provider takes over: it knows nothing of what came before */
  | { type: 'reset' }
  | { type: 'text'; text: string }
  /** the answer so far is void: the turn is being asked again */
  | { type: 'restart' }
  | { type: 'proposal'; id: string; command: string; reason: string }
  | { type: 'usage'; tokens: number }
  | { type: 'cutoff' }
  | { type: 'refused'; rolledBack: boolean }
  | { type: 'stopped' }
  | { type: 'failed'; message: string; rolledBack: boolean }
