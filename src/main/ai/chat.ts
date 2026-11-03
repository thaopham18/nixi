import type { WebContents } from 'electron'
import { redact } from '@shared/redact'
import { aiModelOf, aiProviderInfo, GEMINI_API_PATH, parseAiBaseUrl, parseProposal, prepareAttachment, wrapTerminalOutput, type AiAnswer, type AiEvent, type AiMessageInput, type AiModelInfo, type AiProviderId, type Attachment } from '@shared/ai'
import { allSecrets, deleteSecret, getSecret, hasSecret, setSecret } from '../store/secrets'
import { getSettings } from '../store/stores'
import { anthropic } from './anthropic'
import { openAiCompatible } from './openai'
import { AUTO_RUN_NOTE, SYSTEM_PROMPT, type AiHistoryItem, type AiProvider, type AiToolResult } from './provider'

/** Turns one message may take without the user answering anything. */
const MAX_TURNS = 5

const keyName = (id: AiProviderId): string => `ai:${id}`

export interface AiTarget {
  provider: AiProviderId
  baseUrl?: string
}

interface Active {
  id: AiProviderId
  provider: AiProvider
  /** a conversation belongs to one of these: history formats differ, and it must not move hosts by itself */
  source: string
}

/** Throws when a custom address can't be used. */
function resolve({ provider, baseUrl }: AiTarget): Active {
  const info = aiProviderInfo(provider)
  if (info.id === 'anthropic') return { id: info.id, provider: anthropic, source: info.id }
  let url: string
  if (info.id === 'gemini') {
    // Tests may only point it at this computer, as with Anthropic.
    const test = process.env.NIXI_AI_BASE_URL
    url = (test && /^http:\/\/127\.0\.0\.1:\d+$/.test(test) ? test : 'https://generativelanguage.googleapis.com') + GEMINI_API_PATH
  } else {
    const parsed = parseAiBaseUrl(baseUrl)
    if ('error' in parsed) throw new Error(parsed.error)
    url = parsed.url
  }
  return { id: info.id, provider: openAiCompatible(url, info.id === 'custom' ? new URL(url).host : info.label), source: `${info.id} ${url}` }
}

const saved = (): AiTarget => ({ provider: getSettings().aiProvider, baseUrl: getSettings().aiBaseUrl })
const needsKey = (id: AiProviderId): boolean => id !== 'custom'

interface Chat {
  source?: string
  history: AiHistoryItem[]
  /** the model's commands still waiting for an answer; a result, once answered */
  open: Map<string, AiToolResult | undefined>
  /** results due on the next message, for tool calls that never reached the user */
  invalid: AiToolResult[]
  abort?: AbortController
}

// Only in memory: closing the pane or locking the database ends the conversation.
const chats = new Map<string, Chat>()
let sink: WebContents | undefined

export function setAiSink(wc: WebContents): void {
  sink = wc
}

function emit(chatId: string, event: AiEvent): void {
  if (sink && !sink.isDestroyed()) sink.send('ai:event', chatId, event)
}

/** The same call makes the preview and what is sent, so the two can't differ. */
export function previewAttachment(raw: string): Attachment {
  return prepareAttachment(raw, allSecrets())
}

/** Whether the chosen provider is set up enough to take a message. */
export function aiIsReady(): boolean {
  const { provider, baseUrl } = saved()
  if (provider === 'custom') return !('error' in parseAiBaseUrl(baseUrl))
  return hasSecret(keyName(provider))
}

export function aiHasKey(provider: AiProviderId): boolean {
  return hasSecret(keyName(aiProviderInfo(provider).id))
}

export function setAiKey(provider: AiProviderId, key: string | null): void {
  const name = keyName(aiProviderInfo(provider).id)
  if (key?.trim()) setSecret(name, key.trim())
  else deleteSecret(name)
}

async function withKey<T>(target: AiTarget, key: string | undefined, call: (p: AiProvider, apiKey: string) => Promise<T>): Promise<T> {
  const active = resolve(target)
  const apiKey = key?.trim() || getSecret(keyName(active.id)) || ''
  if (!apiKey && needsKey(active.id)) throw new Error('Enter an API key first')
  try {
    return await call(active.provider, apiKey)
  } catch (err) {
    throw new Error(active.provider.explain(err) ?? 'Stopped')
  }
}

export function testAiKey(target: AiTarget, key?: string): Promise<void> {
  return withKey(target, key, (p, apiKey) => p.checkKey(apiKey))
}

export function listAiModels(target: AiTarget, key?: string): Promise<AiModelInfo[]> {
  return withKey(target, key, (p, apiKey) => p.listModels(apiKey))
}

function chatOf(chatId: string): Chat {
  let chat = chats.get(chatId)
  if (!chat) chats.set(chatId, (chat = { history: [], open: new Map(), invalid: [] }))
  return chat
}

function withAttachment(text: string, attachment: AiMessageInput['attachment']): string {
  const shown = attachment && previewAttachment(attachment.raw)
  if (!shown?.text) return text
  return `${text}\n\n${wrapTerminalOutput(shown.text, attachment!.source)}`
}

/** `rollback`: where the history goes back to if the provider won't take the message. */
async function run(chatId: string, chat: Chat, active: Active, rollback: number | undefined): Promise<void> {
  const apiKey = getSecret(keyName(active.id)) ?? ''
  const { provider } = active
  const abort = new AbortController()
  chat.abort = abort
  const current = (): boolean => chats.get(chatId) === chat && !abort.signal.aborted
  const undo = (): boolean => {
    if (rollback === undefined) return false
    chat.history.length = rollback
    return true
  }
  emit(chatId, { type: 'busy', on: true })
  try {
    if (!apiKey && needsKey(active.id)) return void emit(chatId, { type: 'failed', message: 'Add an API key in Settings first.', rolledBack: undo() })
    let model = aiModelOf(getSettings())
    if (!model) {
      // A server with one model leaves nothing to choose. With more, cost and quality are the user's call.
      const models = await provider.listModels(apiKey).catch(() => [])
      if (!current()) return
      if (models.length !== 1) return void emit(chatId, { type: 'failed', message: 'Pick a model in Settings first.', rolledBack: undo() })
      model = models[0].id
    }
    for (let n = 0; n < MAX_TURNS; n++) {
      const turn = await provider.turn({
        apiKey,
        system: getSettings().aiAutoRun ? SYSTEM_PROMPT + AUTO_RUN_NOTE : SYSTEM_PROMPT,
        model,
        history: chat.history,
        signal: abort.signal,
        onText: (text) => current() && emit(chatId, { type: 'text', text }),
        onRestart: () => current() && emit(chatId, { type: 'restart' })
      })
      if (!current()) return
      emit(chatId, { type: 'usage', tokens: turn.tokens })
      // A refusal can cut a tool call off, and so can the token limit: never act on that turn.
      if (turn.stop === 'refusal') return void emit(chatId, { type: 'refused', rolledBack: undo() })
      if (turn.stop === 'cutoff' && turn.toolCalls.length) return void emit(chatId, { type: 'failed', message: 'The answer was cut off before the command was complete. Ask again.', rolledBack: undo() })
      chat.history.push(turn.assistant)
      rollback = undefined // answered: from here on the history only grows
      if (turn.stop === 'cutoff') emit(chatId, { type: 'cutoff' })
      if (turn.stop === 'pause') continue
      const bad: AiToolResult[] = []
      for (const call of turn.toolCalls) {
        const parsed = parseProposal(call.input)
        if ('error' in parsed) {
          bad.push({ id: call.id, text: `Invalid input: ${parsed.error}. Nothing was shown to the user.`, isError: true })
        } else {
          chat.open.set(call.id, undefined)
          emit(chatId, { type: 'proposal', id: call.id, ...parsed })
        }
      }
      if (!bad.length && !chat.open.size) return
      if (chat.open.size) {
        chat.invalid = bad
        return
      }
      // Nothing for the user to see: tell the model what was wrong and let it try again.
      chat.history.push(provider.userMessage(undefined, bad))
    }
    emit(chatId, { type: 'failed', message: 'The AI kept going without an answer, so Nixi stopped it. Ask again.', rolledBack: false })
  } catch (err) {
    if (chats.get(chatId) !== chat) return
    const message = provider.explain(err) ?? (abort.signal.aborted ? undefined : String(err))
    if (message === undefined) emit(chatId, { type: 'stopped' })
    else emit(chatId, { type: 'failed', message, rolledBack: undo() })
  } finally {
    if (chat.abort === abort) chat.abort = undefined
    if (chats.get(chatId) === chat) emit(chatId, { type: 'busy', on: false })
  }
}

/** Results for everything answered so far, plus what was wrong with any invalid calls. */
function closeOpen(chat: Chat): AiToolResult[] {
  const results = [...chat.open].map(
    ([id, r]) => r ?? { id, text: 'The user wrote a new message instead of answering this. It may or may not have run: do not assume either.' }
  )
  chat.open.clear()
  const all = [...results, ...chat.invalid]
  chat.invalid = []
  return all
}

/** A conversation can't move: the new provider can't read the old one's format, and hasn't been told any of it. */
function startOverIfMoved(chatId: string, chat: Chat, active: Active): boolean {
  const moved = chat.source !== undefined && chat.source !== active.source && chat.history.length > 0
  chat.source = active.source
  if (!moved) return false
  chat.history = []
  chat.open.clear()
  chat.invalid = []
  emit(chatId, { type: 'reset' })
  return true
}

/** Returns the message as sent, secrets hidden: pasted text can hold them too. */
export function aiSend(chatId: string, message: AiMessageInput): string {
  const chat = chatOf(chatId)
  if (chat.abort) throw new Error('The AI is still answering')
  const active = resolve(saved())
  startOverIfMoved(chatId, chat, active)
  const provider = active.provider
  const results = closeOpen(chat)
  const before = chat.history.length
  const text = redact(message.text, allSecrets())
  chat.history.push(provider.userMessage(withAttachment(text, message.attachment), results))
  // With tool results in it the message can't be taken back: their tool calls need them.
  void run(chatId, chat, active, results.length ? undefined : before)
  return text
}

function answerText(answer: AiAnswer): string {
  if (answer.kind === 'skipped') return 'The user chose not to run this command.'
  if (answer.kind === 'kept') return 'The user ran this command but chose not to share the output.'
  const { text, dropped } = previewAttachment(answer.raw)
  const note = dropped ? ` The first ${dropped} lines were left out.` : ''
  const how =
    answer.progress === 'finished'
      ? 'This command ran automatically and the prompt came back.'
      : answer.progress === 'running'
        ? 'This command ran automatically and has not finished: no prompt yet. Output so far.'
        : 'The user ran this command. Output so far; it may still be running.'
  return `${how}${note}\n${wrapTerminalOutput(text)}`
}

export function aiAnswer(chatId: string, id: string, answer: AiAnswer): void {
  const chat = chats.get(chatId)
  if (!chat?.open.has(id)) return // the user moved on with a new message
  chat.open.set(id, { id, text: answerText(answer) })
  if ([...chat.open.values()].some((r) => !r) || chat.abort) return
  const active = resolve(saved())
  // The provider changed while this waited: the output doesn't go to one the user has left, or a new one unasked.
  if (startOverIfMoved(chatId, chat, active)) return
  chat.history.push(active.provider.userMessage(undefined, closeOpen(chat)))
  void run(chatId, chat, active, undefined)
}

export function aiStop(chatId: string): void {
  chats.get(chatId)?.abort?.abort()
}

export function aiClear(chatId: string): void {
  chats.get(chatId)?.abort?.abort()
  chats.delete(chatId)
}

export function aiClearAll(): void {
  for (const id of [...chats.keys()]) aiClear(id)
}
