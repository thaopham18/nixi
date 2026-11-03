/** Auto reconnect: how long to wait, when to stop, and which failures are worth another try. */
/** every 3 seconds for about 10 minutes, long enough for a server to reboot */
export const RETRY_SECONDS = 3
export const RETRY_LIMIT = 200
/** a connection that held this long counts as working again, so the tries start over */
export const STABLE_MS = 30_000

/** The network or the server being away: trying again can help. A rejected login or key can't. */
export function isNetworkError(message: string): boolean {
  return /ECONN|ETIMEDOUT|EHOSTUNREACH|EHOSTDOWN|ENETUNREACH|ENETDOWN|ENOTFOUND|EAI_AGAIN|EPIPE|timed out|could not reach|connection lost|socket|handshake/i.test(message)
}

/** RDP only says why a session ended in words: a logoff must not log straight back in. */
export function isRdpDrop(reason: string): boolean {
  if (/log(ged)?\s?(off|out)|by (the )?(user|administrator)|idle|shut ?down/i.test(reason)) return false
  return /network|connection|socket|websocket|reset|closed|timed? ?out|unexpected|eof/i.test(reason)
}

/** The command line (with or without a prompt in front) asks the server to end the session. */
export function endsSession(line: string): boolean {
  return /(^|[\s$#>%:])(exit|logout|logoff|quit|bye|disconnect)\s*$/i.test(line)
}

/** The pauses of one pane's reconnect loop. The caller connects; this only keeps the time. */
export class Retry {
  private attempt = 0
  private upAt = 0
  private timer: ReturnType<typeof setInterval> | undefined
  /** the user said stop: a try already under way must not start another pause */
  stopped = false

  get waiting(): boolean {
    return this.timer !== undefined
  }

  private clear(): void {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The connection is up. */
  up(now = Date.now()): void {
    this.clear()
    this.upAt = now
    this.stopped = false
  }

  /** The connection dropped. */
  down(now = Date.now()): void {
    this.clear()
    this.stopped = false
    if (this.upAt && now - this.upAt >= STABLE_MS) this.attempt = 0
    this.upAt = 0
  }

  /** Wait for the next try: `tick` each second, then `fire`. False when out of tries or stopped. */
  next(tick: (secondsLeft: number, attempt: number) => void, fire: () => void): boolean {
    if (this.stopped || this.attempt >= RETRY_LIMIT) return false
    let left = RETRY_SECONDS
    const attempt = ++this.attempt
    this.clear()
    tick(left, attempt)
    this.timer = setInterval(() => {
      if (--left > 0) return tick(left, attempt)
      this.clear()
      fire()
    }, 1000)
    return true
  }

  /** Cut the current pause short; the caller tries right away. */
  skip(): void {
    this.clear()
  }

  stop(): void {
    this.clear()
    this.stopped = true
    this.attempt = 0
  }
}
