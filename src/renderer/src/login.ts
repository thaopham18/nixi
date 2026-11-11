import { api } from './api'
import { toast, useStore, type LoginAnswer } from './store'

/**
 * Logins typed during this run, per session, so splits, duplicates and reconnects of the
 * same server don't ask again. Memory only: the database gets them only when the user ticks Save.
 */
interface Typed {
  username?: string
  password?: string
  /** a credential picked without Save: used for this session until the app closes */
  credentialId?: string
}
const typed = new Map<string, Typed>()

export const typedLogin = (sessionId: string): Typed => typed.get(sessionId) ?? {}

export function forgetTypedPassword(sessionId: string): void {
  const t = typed.get(sessionId)
  if (!t) return
  delete t.password
  delete t.credentialId
}

/** Call once the server has accepted the login: a rejected one must never be saved. */
export async function keepLogin(sessionId: string, login: LoginAnswer, secretName = 'Password'): Promise<void> {
  const before = typedLogin(sessionId)
  const username = login.username ?? before.username
  const password = login.password ?? before.password
  // Typing a password over a credential replaces it; a passphrase for its key keeps it.
  const credentialId = login.credentialId ?? (login.password === undefined ? before.credentialId : undefined)
  typed.set(sessionId, { username, password, credentialId })
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
