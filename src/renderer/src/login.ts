import { api } from './api'
import { toast, useStore, type LoginAnswer } from './store'

/**
 * Logins typed during this run, per session, so splits, duplicates and reconnects of the
 * same server don't ask again. Memory only: the database gets them only when the user ticks Save.
 */
const typed = new Map<string, { username?: string; password?: string }>()

export const typedLogin = (sessionId: string): { username?: string; password?: string } => typed.get(sessionId) ?? {}

export function forgetTypedPassword(sessionId: string): void {
  delete typed.get(sessionId)?.password
}

/** Call once the server has accepted the login: a rejected one must never be saved. */
export async function keepLogin(sessionId: string, login: LoginAnswer, secretName = 'Password'): Promise<void> {
  const username = login.username ?? typedLogin(sessionId).username
  const password = login.password ?? typedLogin(sessionId).password
  typed.set(sessionId, { username, password })
  const session = useStore.getState().sessions.find((s) => s.id === sessionId)
  if (!login.remember || !session) return
  if (login.credentialId) {
    useStore.setState({ sessions: await api.saveSession({ ...session, credentialId: login.credentialId }) })
    const name = useStore.getState().credentials.find((c) => c.id === login.credentialId)?.name
    return toast(`${session.name} now uses the credential ${name}`)
  }
  // A login typed over a credential belongs to this session alone: the others using it stay as they are.
  const secret = login.password ?? (session.credentialId ? await api.credentialSecret(session.credentialId) : undefined)
  const sessions = await api.saveSession({ ...session, credentialId: undefined, username: login.username ?? session.username, secret })
  useStore.setState({ sessions })
  toast(`${login.password === undefined ? 'Username' : secretName} for ${session.name} saved in the database`)
}
