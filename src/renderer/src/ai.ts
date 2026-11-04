import { aiProviderInfo, type AiAnswer, type AiEvent } from '@shared/ai'
import { isReadOnlyCommand } from '@shared/readonly'
import { api, errorMessage } from './api'
import { allPanes, askChoice, toast, useStore } from './store'
import { runBlock, runProposed } from './terminals'

export type AiItem =
  | { kind: 'user'; text: string; attachment?: string; undelivered?: boolean }
  | { kind: 'assistant'; text: string; open: boolean; stopped?: boolean }
  | { kind: 'proposal'; id: string; command: string; reason: string; state: 'pending' | 'running' | 'ran' | 'sent' | 'kept' | 'skipped' | 'dropped'; output?: string; holding?: boolean; asks?: string }
  | { kind: 'notice'; text: string; error?: boolean }

export interface AiChat {
  items: AiItem[]
  busy: boolean
  /** a command is running by itself: automatic mode */
  running: boolean
  tokens: number
  draft: string
}

export const EMPTY_CHAT: AiChat = { items: [], busy: false, running: false, tokens: 0, draft: '' }
/** The conversation when no pane is open: nothing to attach or run. */
export const GENERAL_CHAT = 'general'

/** Reads what a command has printed so far, by proposal id. */
const outputs = new Map<string, () => string>()

/** Commands one message may run by themselves, so that a loop has to come back to a person. */
export const MAX_AUTO_RUNS = 20
interface AutoState {
  count: number
  /** Stop was pressed: nothing more runs by itself until the next message */
  stopped: boolean
  /** Commands of one answer run one after another. */
  queue: Promise<void>
}
const autos = new Map<string, AutoState>()
function autoOf(chatId: string): AutoState {
  let a = autos.get(chatId)
  if (!a) autos.set(chatId, (a = { count: 0, stopped: false, queue: Promise.resolve() }))
  return a
}
const autoOn = (): boolean => useStore.getState().settings?.aiAutoRun === true

export function outputOf(id: string): string | undefined {
  return outputs.get(id)?.()
}

export function updateChat(chatId: string, change: (chat: AiChat) => Partial<AiChat>): void {
  useStore.setState((s) => {
    const chat = s.aiChats[chatId] ?? EMPTY_CHAT
    return { aiChats: { ...s.aiChats, [chatId]: { ...chat, ...change(chat) } } }
  })
}

const closeAssistant = (items: AiItem[], stopped = false): AiItem[] =>
  items.map((i) => (i.kind === 'assistant' && i.open ? { ...i, open: false, stopped: stopped || i.stopped } : i))

function markUndelivered(chat: AiChat): Partial<AiChat> {
  const last = chat.items.map((i) => i.kind).lastIndexOf('user')
  const user = chat.items[last]
  if (user?.kind !== 'user') return {}
  return { items: chat.items.map((i, n) => (n === last ? { ...user, undelivered: true } : i)), draft: chat.draft || user.text }
}

function onEvent(chatId: string, e: AiEvent): void {
  updateChat(chatId, (chat): Partial<AiChat> => {
    const notice = (text: string, error = false): AiItem[] => [...closeAssistant(chat.items), { kind: 'notice', text, error }]
    switch (e.type) {
      case 'reset':
        return { tokens: 0, items: [...closeAssistant(chat.items), { kind: 'notice', text: 'The AI provider changed, so this is a new conversation: it has not seen the messages above.' }] }
      case 'busy':
        return { busy: e.on, items: e.on ? chat.items : closeAssistant(chat.items) }
      case 'text': {
        const last = chat.items[chat.items.length - 1]
        if (last?.kind === 'assistant' && last.open) return { items: [...chat.items.slice(0, -1), { ...last, text: last.text + e.text }] }
        return { items: [...chat.items, { kind: 'assistant', text: e.text, open: true }] }
      }
      case 'restart':
        return { items: chat.items.filter((i) => !(i.kind === 'assistant' && i.open)) }
      case 'proposal':
        return { items: [...closeAssistant(chat.items), { kind: 'proposal', id: e.id, command: e.command, reason: e.reason, state: 'pending' }] }
      case 'usage':
        return { tokens: chat.tokens + e.tokens }
      case 'cutoff':
        return { items: notice('The answer reached the length limit and was cut off.') }
      case 'stopped':
        return { items: closeAssistant(chat.items, true) }
      case 'refused': {
        // A declined answer is void, including what had already arrived of it.
        const kept = chat.items.filter((i) => !(i.kind === 'assistant' && i.open))
        const after = e.rolledBack ? markUndelivered({ ...chat, items: kept }) : { items: kept }
        return { ...after, items: [...(after.items ?? kept), { kind: 'notice', error: true, text: 'The AI declined this request. Rephrase it, or use Clear if it keeps happening.' }] }
      }
      case 'failed': {
        const after = e.rolledBack ? markUndelivered(chat) : {}
        return { ...after, items: [...closeAssistant(after.items ?? chat.items), { kind: 'notice', text: e.message, error: true }] }
      }
    }
  })
}

api.onAiEvent((chatId, e) => {
  onEvent(chatId, e)
  if (e.type !== 'proposal' || !autoOn()) return
  const a = autoOf(chatId)
  a.queue = a.queue.then(() => autoRun(chatId, a, e.id, e.command)).catch((err) => toast(errorMessage(err), true))
})

function waitingBefore(chatId: string, id: string): boolean {
  for (const i of useStore.getState().aiChats[chatId]?.items ?? []) {
    if (i.kind !== 'proposal') continue
    if (i.id === id) return false
    if (i.state === 'pending' || i.state === 'ran') return true
  }
  return false
}

/** Anything it can't do alone stays as an ordinary card with Run on it. */
async function autoRun(chatId: string, a: AutoState, id: string, command: string): Promise<void> {
  if (a.stopped || !autoOn() || runBlock(chatId)) return
  if (!isReadOnlyCommand(command)) return setProposal(chatId, id, { asks: 'Auto only runs commands that just look. This one could change something, or is not one it knows.' })
  // Running ahead of a card that waits would do the steps out of order.
  if (waitingBefore(chatId, id)) return setProposal(chatId, id, { asks: 'Waits for the command above.' })
  if (a.count >= MAX_AUTO_RUNS) {
    a.stopped = true
    updateChat(chatId, (chat) => ({ items: [...chat.items, { kind: 'notice', text: `Paused after ${MAX_AUTO_RUNS} commands in a row. Run this one yourself, or send a message to go on.` }] }))
    return
  }
  a.count++
  updateChat(chatId, () => ({ running: true }))
  try {
    setProposal(chatId, id, { state: 'running' })
    const run = await runProposed(chatId, command, false)
    if (!run) return setProposal(chatId, id, { state: 'pending' }) // refused at the dangerous command warning
    outputs.set(id, run.read)
    const how = await run.settle(
      () => a.stopped || !autoOn(),
      (holding) => setProposal(chatId, id, { holding })
    )
    setProposal(chatId, id, { holding: false })
    // Stopped, or a full-screen program only a person can read: hand it over for review.
    if (how === 'cancelled' || how === 'fullscreen') return setProposal(chatId, id, { state: 'ran' })
    const raw = run.read()
    const shown = await api.aiPreview(raw)
    setProposal(chatId, id, { output: shown.text })
    answerProposal(chatId, id, { kind: 'output', raw, progress: how })
  } finally {
    updateChat(chatId, () => ({ running: false }))
  }
}

export function stopAi(chatId: string): void {
  autoOf(chatId).stopped = true
  void api.aiStop(chatId)
}

/** True if it is now in the requested state. */
export async function setAutoRun(on: boolean): Promise<void> {
  const settings = useStore.getState().settings
  if (!settings) return
  if (on) {
    const answer = await askChoice({
      title: 'Let AI run commands by itself?',
      message:
        'AI will run commands that only look (ls, cat, df, ps, systemctl status, SELECT…) without asking, and read their output, until the task is done. Everything else waits for you to click Run.',
      items: [
        'Adding, changing or deleting anything, and any command it does not recognize, still asks.',
        `What a command prints goes to ${aiProviderInfo(settings.aiProvider).label === 'Custom' ? 'your AI server' : aiProviderInfo(settings.aiProvider).label} with no review. Known kinds of secret are hidden, but not all of them can be recognized.`,
        `It pauses after ${MAX_AUTO_RUNS} commands in a row. Stop halts it at any time.`
      ],
      buttons: [
        { label: 'Cancel', value: 'cancel', primary: true },
        { label: 'Turn on', value: 'on', danger: true }
      ]
    })
    if (answer !== 'on') return
  }
  useStore.setState({ settings: await api.setSettings({ ...settings, aiAutoRun: on }) })
}

// A conversation lives as long as its pane.
useStore.subscribe((s, prev) => {
  if (s.tabs === prev.tabs) return
  const alive = new Set(allPanes().map((p) => p.id))
  for (const id of Object.keys(s.aiChats))
    if (id !== GENERAL_CHAT && !alive.has(id)) clearChat(id)
})

export function clearChat(chatId: string): void {
  void api.aiClear(chatId)
  const a = autos.get(chatId)
  if (a) a.stopped = true
  autos.delete(chatId)
  useStore.setState((s) => {
    const { [chatId]: _gone, ...aiChats } = s.aiChats
    return { aiChats }
  })
}

export async function sendAi(chatId: string, text: string, attachment?: { raw: string; source: 'screen' | 'selection'; shown: string }): Promise<void> {
  const a = autoOf(chatId)
  a.count = 0
  a.stopped = false
  updateChat(chatId, (chat) => ({
    draft: '',
    // A new message answers whatever was still open: the model is told so.
    items: [
      ...chat.items.map((i) => (i.kind === 'proposal' && (i.state === 'pending' || i.state === 'ran') ? { ...i, state: 'dropped' as const } : i)),
      { kind: 'user', text, attachment: attachment?.shown }
    ]
  }))
  try {
    const sent = await api.aiSend(chatId, { text, attachment: attachment && { raw: attachment.raw, source: attachment.source } })
    if (sent !== text) updateChat(chatId, (chat) => ({ items: chat.items.map((i) => (i.kind === 'user' && i.text === text ? { ...i, text: sent } : i)) }))
  } catch (err) {
    toast(errorMessage(err), true)
  }
}

function setProposal(chatId: string, id: string, change: Partial<Extract<AiItem, { kind: 'proposal' }>>): void {
  updateChat(chatId, (chat) => ({ items: chat.items.map((i) => (i.kind === 'proposal' && i.id === id ? { ...i, ...change } : i)) }))
}

export async function runProposal(chatId: string, id: string, command: string): Promise<void> {
  try {
    const run = await runProposed(chatId, command)
    if (!run) return
    outputs.set(id, run.read)
    setProposal(chatId, id, { state: 'ran' })
  } catch (err) {
    toast(errorMessage(err), true)
  }
}

/** A command the answer only named: typed in the same way, and the next message's attachment shows how it went. */
export async function runMentioned(chatId: string, command: string): Promise<void> {
  try {
    await runProposed(chatId, command)
  } catch (err) {
    toast(errorMessage(err), true)
  }
}

export function answerProposal(chatId: string, id: string, answer: AiAnswer): void {
  setProposal(chatId, id, { state: answer.kind === 'output' ? 'sent' : answer.kind })
  outputs.delete(id)
  api.aiAnswer(chatId, id, answer).catch((err) => toast(errorMessage(err), true))
}
