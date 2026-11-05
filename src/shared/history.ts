/** Suggestions while typing: which commands are worth keeping, and which one fits what's typed. */
import { asksForSecret } from './ai'
import { redact } from './redact'

/** per session; the oldest go first */
export const HISTORY_LIMIT = 1000
const MIN_TYPED = 2
const MAX_LENGTH = 500

// The prompt ends at the first $ # % > ❯ with a space after it (or at the end of the line).
const PROMPT = /^(?:[A-Za-z]:\\[^>]*>|.*?[$#%>❯](?:\s+|$))(.*)$/

/** The command on a line of the screen, or undefined when there's no prompt to tell it from. */
export function commandFromLine(line: string): string | undefined {
  return PROMPT.exec(line)?.[1]
}

/**
 * Two readings of the command on a line: after a prompt it recognises, and after where the first key
 * was pressed. The first can stop too late (`➜ ~ echo a > b`), the second too early (the second
 * half of a line continued with `\\`), so the longer one is right.
 */
export function longerCommand(afterPrompt: string | undefined, afterFirstKey: string | undefined): string | undefined {
  if (afterPrompt === undefined) return afterFirstKey
  return afterFirstKey !== undefined && afterFirstKey.length > afterPrompt.length ? afterFirstKey : afterPrompt
}

/**
 * What ran, or undefined if it shouldn't be kept. It comes from the screen, because Tab and the
 * arrow keys make the keys differ from the command, and because what isn't echoed (a password) must
 * never be kept. The keys only finish a command whose echo is still on its way.
 */
export function commandToKeep(onScreen: string, typed: string, afterFirstKey?: string): string | undefined {
  if (asksForSecret(onScreen)) return undefined
  let command = longerCommand(commandFromLine(onScreen), afterFirstKey)?.trim()
  if (!command) return undefined
  // A prompt that asks for a secret but echoes it, in whatever shape.
  if (/pass(?:word|phrase|code)|\botp\b|\bpin\b/i.test(onScreen.slice(0, onScreen.length - command.length))) return undefined
  const keys = typed.trim()
  if (keys.length > command.length && keys.startsWith(command)) command = keys
  // A leading space on the keys means "keep this out of history", as in bash and zsh.
  if (typed.startsWith(' ') || command.length < MIN_TYPED || command.length > MAX_LENGTH) return undefined
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(command) || redact(command) !== command) return undefined
  return command
}

/** The list with this command as the newest, once. */
export function addToHistory(list: readonly string[], command: string, limit = HISTORY_LIMIT): string[] {
  return [...list.filter((c) => c !== command), command].slice(-limit)
}

/** What to add to `typed`: from the newest match, in the first list that has one. */
export function suggestRest(typed: string, ...lists: (readonly string[])[]): string | undefined {
  if (typed.length < MIN_TYPED) return undefined
  for (const list of lists) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].length > typed.length && list[i].startsWith(typed)) return list[i].slice(typed.length)
    }
  }
  return undefined
}
