// Minimal Telnet client protocol (RFC 854/855) with the options a terminal needs:
// ECHO (1) and SUPPRESS-GO-AHEAD (3) from the server, TERMINAL-TYPE (24, RFC 1091) and
// NAWS window size (31, RFC 1073) from us. Everything else is refused.

export const IAC = 255
export const DONT = 254
export const DO = 253
export const WONT = 252
export const WILL = 251
export const SB = 250
export const SE = 240
export const OPT_ECHO = 1
export const OPT_SGA = 3
export const OPT_TTYPE = 24
export const OPT_NAWS = 31
const TTYPE_IS = 0
const TTYPE_SEND = 1

/** Options we perform (WILL) and options we let the server perform (DO). */
const OURS = new Set([OPT_TTYPE, OPT_NAWS])
const THEIRS = new Set([OPT_ECHO, OPT_SGA])

type State = 'data' | 'iac' | 'cmd' | 'sb' | 'sb-iac'

export class TelnetClient {
  private state: State = 'data'
  private cmd = 0
  private sb: number[] = []
  private pendingCr = false
  /** options currently enabled on our side / the server side */
  readonly local = new Set<number>()
  readonly remote = new Set<number>()
  private size = { cols: 80, rows: 24 }

  constructor(
    private send: (bytes: Buffer) => void,
    private termType = 'XTERM-256COLOR'
  ) {}

  /** Feed bytes from the server; returns the application data with protocol bytes removed. */
  receive(chunk: Buffer): Buffer {
    const out: number[] = []
    for (const b of chunk) {
      switch (this.state) {
        case 'data':
          if (b === IAC) this.state = 'iac'
          else if (this.pendingCr && b === 0) this.pendingCr = false // CR NUL means a bare CR
          else {
            this.pendingCr = b === 13
            out.push(b)
          }
          break
        case 'iac':
          if (b === IAC) {
            out.push(IAC) // escaped 0xFF data byte
            this.state = 'data'
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.cmd = b
            this.state = 'cmd'
          } else if (b === SB) {
            this.sb = []
            this.state = 'sb'
          } else {
            this.state = 'data' // NOP, GA, AYT…: nothing to do
          }
          break
        case 'cmd':
          this.negotiate(this.cmd, b)
          this.state = 'data'
          break
        case 'sb':
          if (b === IAC) this.state = 'sb-iac'
          else this.sb.push(b)
          break
        case 'sb-iac':
          if (b === SE) {
            this.subnegotiation(this.sb)
            this.state = 'data'
          } else {
            if (b === IAC) this.sb.push(IAC)
            this.state = 'sb'
          }
          break
      }
    }
    return Buffer.from(out)
  }

  private reply(cmd: number, opt: number): void {
    this.send(Buffer.from([IAC, cmd, opt]))
  }

  private negotiate(cmd: number, opt: number): void {
    if (cmd === DO) {
      if (!OURS.has(opt)) return this.reply(WONT, opt)
      if (this.local.has(opt)) return // already on: don't answer, avoids negotiation loops
      this.local.add(opt)
      this.reply(WILL, opt)
      if (opt === OPT_NAWS) this.sendSize()
    } else if (cmd === DONT) {
      if (this.local.delete(opt)) this.reply(WONT, opt)
    } else if (cmd === WILL) {
      if (!THEIRS.has(opt)) return this.reply(DONT, opt)
      if (this.remote.has(opt)) return
      this.remote.add(opt)
      this.reply(DO, opt)
    } else if (cmd === WONT) {
      if (this.remote.delete(opt)) this.reply(DONT, opt)
    }
  }

  private subnegotiation(data: number[]): void {
    if (data[0] === OPT_TTYPE && data[1] === TTYPE_SEND && this.local.has(OPT_TTYPE)) {
      this.send(Buffer.concat([Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_IS]), Buffer.from(this.termType, 'ascii'), Buffer.from([IAC, SE])]))
    }
  }

  /** Window size changed: tell the server if it asked for NAWS. */
  resize(cols: number, rows: number): void {
    this.size = { cols, rows }
    if (this.local.has(OPT_NAWS)) this.sendSize()
  }

  private sendSize(): void {
    const { cols, rows } = this.size
    const body = [cols >> 8, cols & 0xff, rows >> 8, rows & 0xff].flatMap((b) => (b === IAC ? [IAC, IAC] : [b]))
    this.send(Buffer.from([IAC, SB, OPT_NAWS, ...body, IAC, SE]))
  }

  /** Encode user input: Enter → CR LF (Telnet new line), 0xFF doubled. */
  encode(data: string, encoding: BufferEncoding = 'utf8'): Buffer {
    const text = data.replace(/\r(?!\n)/g, '\r\n')
    const bytes = Buffer.from(text, encoding)
    if (!bytes.includes(IAC)) return bytes
    const out: number[] = []
    for (const b of bytes) {
      out.push(b)
      if (b === IAC) out.push(IAC)
    }
    return Buffer.from(out)
  }
}

/** Watches output for login/password prompts to sign in automatically (once each). */
export class AutoLogin {
  private buf = ''
  private sentUser = false
  private sentPassword = false

  constructor(
    private username: string | undefined,
    private password: string | undefined,
    private type: (text: string) => void
  ) {}

  get done(): boolean {
    return (!this.username || this.sentUser) && (!this.password || this.sentPassword)
  }

  feed(text: string): void {
    if (this.done) return
    // eslint-disable-next-line no-control-regex
    this.buf = (this.buf + text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')).slice(-200)
    if (this.username && !this.sentUser && /(login|user ?name|user)\s*:\s*$/i.test(this.buf)) {
      this.sentUser = true
      this.buf = ''
      this.type(this.username + '\r')
    } else if (this.password && !this.sentPassword && /password\s*:\s*$/i.test(this.buf)) {
      this.sentPassword = true
      this.buf = ''
      this.type(this.password + '\r')
    }
  }
}
