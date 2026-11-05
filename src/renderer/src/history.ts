/** The commands suggestions come from. Main keeps them in the database; this is the copy to search. */
import { addToHistory } from '@shared/history'
import { api } from './api'

const LOCAL = 'local'
let lists: Record<string, string[]> = {}
let loaded = false

export function loadCommandHistory(): void {
  if (loaded) return
  loaded = true
  api.commandHistory().then(
    (saved) => (lists = saved),
    () => (loaded = false)
  )
}

export function keepCommand(sessionId: string | undefined, command: string): void {
  const key = sessionId ?? LOCAL
  lists = { ...lists, [key]: addToHistory(lists[key] ?? [], command) }
  void api.rememberCommand(key, command).catch(() => undefined)
}

/** This session's commands first, then every other session's. */
export function historyLists(sessionId: string | undefined): string[][] {
  const own = sessionId ?? LOCAL
  return [lists[own] ?? [], ...Object.entries(lists).filter(([key]) => key !== own).map(([, list]) => list)]
}

export function forgetCommandHistory(): void {
  lists = {}
}
