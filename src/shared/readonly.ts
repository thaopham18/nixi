// Which commands the AI may run without asking, in Auto. An allow list on purpose: anything not
// recognized waits for the user, including whatever a real shell could do that this doesn't parse.
// Best effort, and only as honest as the server: an alias or a tampered `ls` is out of its sight.

const STDERR_ONLY = /2>(?:\/dev\/null|&1)(?=\s|[;|&]|$)/y

/** Split into the words of each command, or undefined for shell features that could write, run other things or expand to a secret. */
function parseShell(command: string): string[][] | undefined {
  const segments: string[][] = [[]]
  let word = ''
  let inWord = false
  let quote: '"' | "'" | undefined
  const endWord = (): void => {
    if (inWord) segments[segments.length - 1].push(word)
    word = ''
    inWord = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === '\n' || c === '\r') return undefined
    if (quote) {
      if (c === quote) quote = undefined
      else if (quote === '"' && '`\\$!'.includes(c)) return undefined
      else word += c
      continue
    }
    STDERR_ONLY.lastIndex = i
    const stderr = inWord ? null : STDERR_ONLY.exec(command)
    if (stderr) {
      i += stderr[0].length - 1
    } else if (c === '"' || c === "'") {
      quote = c
      inWord = true
    } else if (/\s/.test(c)) {
      endWord()
    } else if (c === ';' || c === '|' || (c === '&' && command[i + 1] === '&')) {
      endWord()
      if (c !== ';' && command[i + 1] === c) i++
      segments.push([])
    } else if ('<>&`()\\{}$!*?['.includes(c)) {
      return undefined // a glob too: it can spell a file the list below would refuse
    } else {
      word += c
      inWord = true
    }
  }
  if (quote) return undefined
  endWord()
  return segments
}

/** Reading these would hand secrets to the AI, however harmless the command. */
const SENSITIVE =
  /(?:^|\/)(?:shadow|gshadow|sudoers|\.env(?:\.[\w.-]+)?|\.netrc|\.pgpass|\.my\.cnf|\.git-credentials|id_[a-z0-9]+|credentials|authorized_keys|known_hosts|\.bash_history|\.zsh_history|wp-config\.php)$|\.(?:pem|key|p12|pfx|kdbx|nxdb|ezdb)$|^\/dev\/|^\/proc\/.*\/environ$|^env:|(?:^|\/)\.(?:ssh|aws|gnupg|kube)\b/i

const has = (args: string[], ...flags: string[]): boolean =>
  args.some((a) => flags.some((f) => a === f || (f.startsWith('--') && a.startsWith(f + '='))))
/** A one-letter flag, also inside a cluster like -fn100. May see a letter of its value: that only means asking. */
const hasShort = (args: string[], letter: string): boolean => args.some((a) => /^-[a-zA-Z]/.test(a) && a.includes(letter))
const following = (args: string[]): boolean => hasShort(args, 'f') || hasShort(args, 'F') || has(args, '--follow')
const onlyFlags = (args: string[], allowed: RegExp): boolean => args.every((a) => allowed.test(a))
const sub = (args: string[], ...names: string[]): boolean => names.includes(args[0])

const PLAIN = new Set(
  (
    'ls ll la pwd cd cat nl wc head stat file du df free uptime uname whoami id groups who w last lsof netstat dig nslookup host ' +
    'traceroute tracepath which whereis type lsblk blkid lscpu lsmem lspci lsusb lsmod modinfo arch nproc tty locale findmnt getent grep egrep fgrep ' +
    'echo printf cut tr sleep true clear basename dirname realpath readlink md5sum sha1sum sha256sum'
  ).split(' ')
)

// Commands that can also change things, never end, or print secrets: what makes each fine to run.
const CHECKED: Record<string, (args: string[]) => boolean> = {
  ps: (a) => !a.some((x) => /^[a-zA-Z]*e[a-zA-Z]*$/.test(x)), // BSD `e` prints every process's environment
  tail: (a) => !following(a),
  rg: (a) => !has(a, '--pre', '--hostname-bin'),
  sort: (a) => !hasShort(a, 'o') && !has(a, '--output', '--compress-program'),
  uniq: (a) => a.filter((x) => !x.startsWith('-')).length <= 1, // a second name is a file to write
  date: (a) => onlyFlags(a, /^(?:\+.*|-u|-R|-I\w*|--utc|--iso-8601(?:=\w+)?|--rfc-\S+)$/), // a bare number sets the clock
  hostname: (a) => onlyFlags(a, /^-[fisdAIy]+$/),
  ss: (a) => !hasShort(a, 'K') && !has(a, '--kill'),
  ping: (a) => hasShort(a, 'c'), // otherwise it never ends
  dmesg: (a) => !a.some((x) => /^-[a-zA-Z]*[cCDEnwW]/.test(x)) && !has(a, '--clear', '--read-clear', '--console-off', '--console-on', '--console-level', '--follow'),
  find: (a) => !has(a, '-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprint0', '-fprintf', '-fls'),
  ifconfig: (a) => onlyFlags(a, /^-a$/),
  mount: (a) => a.length === 0,
  swapon: (a) => a.length === 0 || has(a, '--show') || has(a, '-s'),
  sysctl: (a) => !hasShort(a, 'w') && !hasShort(a, 'p') && !has(a, '--write', '--load', '--system') && !a.some((x) => x.includes('=')),
  top: (a) => hasShort(a, 'b') && hasShort(a, 'n'), // batch mode with a count
  vmstat: (a) => a.filter((x) => /^\d+$/.test(x)).length !== 1, // one number repeats forever
  iostat: (a) => a.filter((x) => /^\d+$/.test(x)).length !== 1,
  ip: (a) => {
    const words = a.filter((x) => !x.startsWith('-'))
    // `ip` takes any abbreviation, so `ip a a` adds an address: only the spelled-out reads pass.
    return /^(?:a|addr|address|l|link|r|route|n|neigh|neighbor|neighbour|rule|maddr)$/.test(words[0] ?? '') && (words.length === 1 || /^(?:show|list|lst|get)$/.test(words[1]))
  },
  iptables: (a) => (hasShort(a, 'L') || hasShort(a, 'S') || has(a, '--list', '--list-rules')) && !a.some((x) => /^-[a-zA-Z]*[AIDRFXNPZE]/.test(x) || /^--(?:append|insert|delete|replace|flush|delete-chain|new-chain|policy|zero|rename-chain)/.test(x)),
  nft: (a) => sub(a, 'list'),
  route: (a) => onlyFlags(a, /^-[nveAF]+$/),
  journalctl: (a) => !following(a) && !a.some((x) => /^--(?:rotate|flush|sync|relinquish-var|smart-relinquish-var|vacuum|setup-keys|update-catalog)/.test(x)),
  systemctl: (a) => /^(?:status|show|cat|list-[\w-]+|is-active|is-enabled|is-failed|get-default)$/.test(a.find((x) => !x.startsWith('-')) ?? '') && !following(a),
  service: (a) => a.length === 2 && a[1] === 'status',
  timedatectl: (a) => a.length === 0 || sub(a, 'status', 'show', 'list-timezones'),
  hostnamectl: (a) => a.length === 0 || sub(a, 'status'),
  docker: (a) => {
    if (following(a)) return false
    // Not inspect or compose config: both print the environment, passwords included.
    if (sub(a, 'ps', 'images', 'logs', 'version', 'info', 'top', 'port', 'diff', 'history')) return true
    if (sub(a, 'stats')) return has(a, '--no-stream')
    return sub(a, 'container', 'image', 'volume', 'network', 'compose') && /^(?:ls|list|ps|logs)$/.test(a[1] ?? '')
  },
  kubectl: (a) => {
    const words = a.filter((x) => !x.startsWith('-'))
    if (following(a) || has(a, '--watch') || hasShort(a, 'w') || words.some((w) => /secret/i.test(w))) return false
    return /^(?:get|describe|logs|top|version|api-resources|api-versions|cluster-info|explain)$/.test(words[0] ?? '') || (words[0] === 'config' && /^(?:current-context|get-contexts)$/.test(words[1] ?? ''))
  },
  git: (a) => {
    if (has(a, '--output', '--ext-diff', '--textconv', '--open-files-in-pager') || a.some((x) => x.startsWith('-O'))) return false
    if (sub(a, 'status', 'log', 'diff', 'show', 'blame', 'shortlog', 'describe', 'rev-parse', 'ls-files', 'grep')) return true
    if (sub(a, 'branch')) return onlyFlags(a.slice(1), /^(?:-a|-r|-v|-vv|--list|--show-current|--all|--remotes)$/)
    if (sub(a, 'remote')) return onlyFlags(a.slice(1), /^-v$/)
    return sub(a, 'tag') && onlyFlags(a.slice(1), /^(?:-l|--list)$/)
  },
  // network devices: these only display
  show: () => true,
  display: () => true
}

const WINDOWS_PLAIN = new Set(['dir', 'tasklist', 'systeminfo', 'getmac', 'where', 'ver', 'vol', 'pathping', 'tracert', 'test-connection', 'test-netconnection', 'select-string', 'measure-object', 'sort-object', 'format-table', 'format-list', 'select-object', 'where-object'])
const POWERSHELL_SECRETS = /credential|secret|clipboard|history|password|token/i

function commandAllowed(words: string[]): boolean {
  let [name, ...args] = words
  if (name === 'sudo') {
    // Plain sudo only: its options can switch to other users, or run an editor.
    ;[name, ...args] = args
    if (!name || name.startsWith('-')) return false
  }
  if (!name) return false
  name = name.replace(/^\/(?:usr\/)?s?bin\//, '')
  if (name.includes('/') || name.includes('=')) return false // a script, or VAR=x in front of a command
  if (args.some((a) => SENSITIVE.test(a))) return false
  if (PLAIN.has(name)) return true
  const check = Object.prototype.hasOwnProperty.call(CHECKED, name) ? CHECKED[name] : undefined
  if (check) return check(args)
  const lower = name.toLowerCase()
  if (lower === 'ipconfig') return onlyFlags(args, /^\/all$/i)
  if (WINDOWS_PLAIN.has(lower)) return true
  return /^get-[a-z]+$/i.test(name) && !POWERSHELL_SECRETS.test(name)
}

// One read-only statement, typed at a mysql or psql prompt or passed with -e / -c. A function the
// database defines can still write: that is beyond what the text shows.
const SQL_START = /^\s*(?:select|show|describe|desc|explain)\b/i
const SQL_WRITES = /\b(?:into|outfile|dumpfile|load_file|for\s+(?:update|share)|lock\s+in|analyze|nextval|setval|set_config|dblink\w*|pg_\w+(?=\s*\()|lo_\w+|sleep|benchmark|insert|update|delete|drop|alter|create|truncate|replace|grant|revoke|call|exec|execute|merge|copy)\b/i
// At a shell prompt this same text would run: `SELECT $(rm x)`. A backslash is a client command: \! runs a shell.
const SQL_NOT_SHELL = /[`$<>|&{}\\!\n\r]/

function sqlReadOnly(statement: string): boolean {
  const body = statement.replace(/;\s*$/, '')
  return SQL_START.test(body) && !body.includes(';') && !SQL_NOT_SHELL.test(body) && !SQL_WRITES.test(body)
}

function sqlClient(words: string[]): boolean {
  const [name, ...args] = words
  if (name !== 'mysql' && name !== 'mariadb' && name !== 'psql') return false
  const flag = name === 'psql' ? ['-c', '--command'] : ['-e', '--execute']
  const at = args.findIndex((a) => flag.includes(a))
  return at >= 0 && at + 1 < args.length && sqlReadOnly(args[at + 1]) && !args.some((a, i) => i !== at + 1 && /^-(?:f|-file)\b/.test(a))
}

/** True only for what is known to look without touching: everything else asks. */
export function isReadOnlyCommand(command: string): boolean {
  if (sqlReadOnly(command)) return true
  const segments = parseShell(command)
  if (!segments || segments.some((s) => s.length === 0)) return false
  return segments.every((words) => commandAllowed(words) || sqlClient(words))
}
