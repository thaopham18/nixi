// Spots commands that are hard to undo, so the terminal can ask before running them. A safety net
// against slips (wrong tab, wrong server), not a security boundary: `r''m -rf` gets through.

interface DangerRule {
  reason: string
  re: RegExp
}

// A command name: not part of a longer word or file name (`farm`, `my-rm`, `shutdown.log`), but /bin/rm counts.
const cmd = (name: string): string => `(?<![\\w-])${name}(?![\\w.-])`
// The rest of the same command: stops at ; & | and line ends.
const args = '[^;&|\\n]*?'

const rules: DangerRule[] = [
  // files and disks
  {
    reason: 'Deletes files without asking',
    re: new RegExp(`(?<!\\b(?:git|docker|podman|nerdctl|s3)\\s+)${cmd('rm')}${args}\\s(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force|--no-preserve-root)(?![\\w-])`)
  },
  { reason: 'Deletes every file it finds', re: new RegExp(`${cmd('find')}${args}\\s(?:-delete|-exec\\s+(?:\\S*/)?(?:rm|shred)\\b)`) },
  { reason: 'Overwrites a file beyond recovery', re: new RegExp(cmd('shred') + '\\s') },
  { reason: 'Erases a disk or partition', re: /(?<![\w-])(?:mkfs(?:\.\w+)?|wipefs|sgdisk\s+(?:-Z|--zap)|blkdiscard)(?![\w-])/ },
  { reason: 'Writes straight to a disk', re: new RegExp(`${cmd('dd')}${args}\\sof=/dev/(?!null\\b|zero\\b)|>\\s*/dev/(?:sd|hd|vd|xvd|nvme|mmcblk|disk|rdisk)`) },
  { reason: 'Changes owner or permissions of a whole system folder', re: new RegExp(`${cmd('ch(?:mod|own)')}${args}\\s(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)\\s${args}\\s/(?:etc|usr|var|bin|sbin|lib|boot|home|root)?/?(?:\\s|$)`, 'm') },
  { reason: 'Fork bomb: freezes the machine', re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/ },
  // the machine
  { reason: 'Shuts down or restarts the machine', re: new RegExp(`${cmd('(?:shutdown|reboot|poweroff|halt)')}|${cmd('init')}\\s+[06](?!\\S)|${cmd('systemctl')}\\s+(?:reboot|poweroff|halt|kexec)`) },
  { reason: 'Kills every process you can reach', re: new RegExp(`${cmd('kill')}\\s+-(?:9|KILL|SIGKILL)\\s+-1(?!\\d)`) },
  { reason: 'Can cut this connection: firewall or network goes away', re: new RegExp(`${cmd('iptables')}\\s+(?:-t\\s+\\S+\\s+)?(?:-F|--flush)|${cmd('nft')}\\s+flush|${cmd('ufw')}\\s+(?:disable|reset)|${cmd('ip')}\\s+link\\s+set\\s+\\S+\\s+down|${cmd('ifconfig')}\\s+\\S+\\s+down|${cmd('ifdown')}\\s`) },
  { reason: 'Deletes a system account', re: new RegExp(`${cmd('(?:userdel|deluser)')}\\s`) },
  { reason: 'Deletes all scheduled jobs', re: new RegExp(`${cmd('crontab')}\\s+-[a-z]*r`) },
  { reason: 'Runs a script from the internet without reading it', re: new RegExp(`${cmd('(?:curl|wget)')}[^;&\\n]*\\|\\s*(?:sudo\\s+(?:-\\S+\\s+)*)?(?:\\S*/)?(?:ba|z|da|k)?sh(?![\\w-])`) },
  // databases
  { reason: 'SQL: permanently removes it and its data', re: /(?<![\w-])drop\s+(?:temporary\s+)?(?:table|database|schema|index|view|user|role|tablespace|function|procedure|trigger|sequence|owned)(?![\w-])/i },
  { reason: 'SQL: empties the table', re: /(?<![\w-])truncate\s+(?:table\s+)?[\w.`"[\]]+\s*(?:;|cascade\b|restart\b|["'])/i },
  { reason: 'SQL: removes a column or constraint', re: /(?<![\w-])alter\s+table\s+\S+\s+drop\s/i },
  { reason: 'SQL: DELETE without WHERE removes every row', re: /(?<![\w-])delete\s+from\s+[\w.`"[\]]+\s*(?:;|["'])/i },
  { reason: 'SQL: UPDATE without WHERE changes every row', re: /(?<![\w-])update\s+[\w.`"[\]]+\s+set\s(?:(?!\bwhere\b)[^;])*;/i },
  { reason: 'Deletes a whole database', re: /(?<![\w-])(?:dropdb|dropuser|mysqladmin\s+(?:-\S+\s+)*drop)(?![\w-])|\.dropDatabase\s*\(|\.drop\s*\(\s*\)|\.deleteMany\s*\(\s*\{\s*\}\s*\)/ },
  { reason: 'Redis: deletes every key', re: /(?<![\w-])(?:flushall|flushdb)(?![\w-])/i },
  // git, containers, cloud
  { reason: 'Git: overwrites history on the server', re: new RegExp(`${cmd('git')}\\s+push${args}\\s(?:--force(?:-with-lease)?|-[a-zA-Z]*f[a-zA-Z]*)(?![\\w-])`) },
  { reason: 'Git: throws away uncommitted work', re: new RegExp(`${cmd('git')}\\s+(?:reset\\s+${args}--hard|clean\\s+${args}-[a-zA-Z]*f)`) },
  { reason: 'Removes containers, images or volumes', re: new RegExp(`${cmd('(?:docker|podman|nerdctl)')}\\s+(?:${args}\\s)?(?:system\\s+prune|volume\\s+(?:rm|prune)|rm\\s+${args}-[a-zA-Z]*f|rmi\\s+${args}-[a-zA-Z]*f)|${cmd('docker[- ]compose')}\\s+down\\s+${args}(?:-v\\b|--volumes)`) },
  { reason: 'Kubernetes: deletes resources', re: new RegExp(`${cmd('(?:kubectl|oc)')}\\s+(?:${args}\\s)?delete(?![\\w-])|${cmd('helm')}\\s+(?:${args}\\s)?(?:uninstall|delete)(?![\\w-])`) },
  { reason: 'Destroys cloud resources', re: new RegExp(`${cmd('terraform')}\\s+(?:${args}\\s)?destroy(?![\\w-])|${cmd('aws')}\\s+s3\\s+(?:rb|rm\\s+${args}--recursive)|${cmd('aws')}\\s+\\S+\\s+(?:terminate-|delete-)\\S+|${cmd('(?:gcloud|az)')}\\s+${args}\\s(?:delete|destroy)(?![\\w-])`) },
  // Windows
  { reason: 'Deletes files without asking', re: /(?<![\w-])(?:del|erase|rd|rmdir)\s[^;&|\n]*\/[sfq]\b/i },
  { reason: 'Deletes files without asking', re: /(?<![\w-])(?:Remove-Item|ri|rm|del|rmdir)\s[^;&|\n]*-(?:Recurse|Force)\b/i },
  { reason: 'Erases a disk or partition', re: /(?<![\w-])format\s+[a-z]:|(?<![\w-])(?:Format-Volume|Clear-Disk|Remove-Partition|diskpart)(?![\w-])/i },
  { reason: 'Shuts down or restarts the machine', re: /(?<![\w-])(?:Stop-Computer|Restart-Computer)(?![\w-])/i },
  { reason: 'Changes the Windows registry or boot setup', re: /(?<![\w-])(?:reg\s+delete|Remove-ItemProperty|bcdedit)(?![\w-])/i },
  { reason: 'Deletes backups or a system account', re: /(?<![\w-])(?:vssadmin\s+delete|net\s+user\s+\S+\s+\/delete)(?![\w-])/i },
  // network gear (the prompt ends in # or >)
  { reason: 'Erases the device configuration', re: /(?<![\w-])(?:write\s+erase|erase\s+(?:startup-config|nvram|flash)|format\s+flash|delete\s+flash:)/i },
  { reason: 'Restarts the device', re: /(?:^|[#>]\s*)reload(?:\s+in\b.*)?\s*$/im }
]

// Only talking about a command, not running it: `grep "rm -rf" log`, `man shutdown`.
const MENTION = /(?:^|\s)(?:echo|printf|grep|egrep|fgrep|rg|ag|ack|man|tldr|which|whereis|whatis|apropos|type|help|history)\s/
const SEGMENT_START = /[;&|\n`]|\$\(/g

function onlyMentioned(text: string, index: number): boolean {
  const before = text.slice(0, index)
  let start = 0
  for (const m of before.matchAll(SEGMENT_START)) start = m.index + m[0].length
  return MENTION.test(before.slice(start))
}

/** Words from the user's own list match anywhere, ignoring case and how many spaces are in between. */
function watchRule(word: string): DangerRule | undefined {
  const parts = word.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return undefined
  const body = parts.map((p) => p.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')).join('\\s+')
  return { reason: `On your watch list: ${parts.join(' ')}`, re: new RegExp(`(?<![\\w-])${body}(?![\\w-])`, 'i') }
}

/** Why `text` (one or more command lines) is dangerous; empty when it looks fine. */
export function findDanger(text: string, watchList: string[] = []): string[] {
  const reasons = new Set<string>()
  const extra = watchList.map(watchRule).filter((r): r is DangerRule => Boolean(r))
  for (const rule of [...rules, ...extra]) {
    const flags = rule.re.flags.includes('g') ? rule.re.flags : rule.re.flags + 'g'
    for (const m of text.matchAll(new RegExp(rule.re.source, flags))) {
      if (onlyMentioned(text, m.index)) continue
      reasons.add(rule.reason)
      break
    }
  }
  return [...reasons]
}

/** A prompt that continues the previous line: mysql `->`, `'>`, python `...`, psql `mydb-#`, shell `>`. */
const CONTINUATION = /^\s*(?:->|['"`]>|\.\.\.|>|\S*-[#(>'"])\s+/

/**
 * The command on screen, oldest line first. `lineAt(0)` is the line under the cursor (wrapped rows
 * already joined), `lineAt(1)` the one above it, and so on. Multi-line SQL and `\` continuations
 * count: "DROP TABLE" on one line and "users;" on the next is still one statement.
 */
export function commandOnScreen(lineAt: (back: number) => string | undefined): string {
  const parts: string[] = []
  for (let back = 0; back < 20; back++) {
    const line = lineAt(back)
    if (line === undefined) break
    const isContinuation = CONTINUATION.test(line)
    parts.unshift(line.replace(CONTINUATION, '').replace(/\\\s*$/, ''))
    const above = lineAt(back + 1)
    if (!isContinuation && !above?.trimEnd().endsWith('\\')) break
  }
  return parts.join(' ').trim()
}

/**
 * What the user has typed since the last Enter, reported when Enter comes. The screen can't tell on
 * a slow link (the echo arrives after the key), this can. It stops knowing as soon as the cursor
 * moves or the shell fills in text: the screen covers those.
 */
export class InputLine {
  private text = ''

  /** Lines that this input sends off (an Enter or more in it), or undefined if there is no Enter yet. */
  feed(data: string): string[] | undefined {
    const sent: string[] = []
    let i = 0
    while (i < data.length) {
      const c = data[i]
      if (data.startsWith('\x1b[200~', i)) {
        // Bracketed paste: its line breaks don't run anything until a real Enter.
        const end = data.indexOf('\x1b[201~', i)
        const stop = end < 0 ? data.length : end
        this.text += data.slice(i + 6, stop).replace(/\r\n?/g, '\n')
        i = end < 0 ? data.length : end + 6
      } else if (c === '\x1b') {
        // eslint-disable-next-line no-control-regex
        const seq = /^\x1b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)?/.exec(data.slice(i))![0]
        // Focus events and terminal replies go by on their own; the rest moves the cursor or edits.
        if (!/^\x1b\[(?:I|O|[0-9;?]*[Rcn])$/.test(seq)) this.text = ''
        i += seq.length
      } else if (c === '\r' || c === '\n') {
        sent.push(...this.text.split('\n'))
        this.text = ''
        i++
      } else if (c === '\x7f' || c === '\b') {
        this.text = this.text.slice(0, -1)
        i++
      } else if (c === '\x17') {
        this.text = this.text.replace(/\S+\s*$/, '')
        i++
      } else if (c === '\t') {
        i++ // completion: the shell adds text we can't see from here
      } else if (c < ' ') {
        this.text = ''
        i++
      } else {
        this.text += c
        i++
      }
    }
    return sent.length ? sent : undefined
  }

  clear(): void {
    this.text = ''
  }
}

/** The lines a macro would run. */
export function macroLines(texts: string[]): string {
  return texts.join('').split(/\r\n|\r|\n/).filter(Boolean).join('\n')
}
