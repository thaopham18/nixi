// Pure helpers shared by main, renderer and tests.

export interface SshConfigHost {
  alias: string
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

/** Minimal ~/.ssh/config parser: concrete Host entries (no wildcards). */
export function parseSshConfig(text: string): SshConfigHost[] {
  const out: SshConfigHost[] = []
  let current: SshConfigHost[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const m = line.match(/^(\S+)\s*(?:=\s*|\s+)(.+)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim().replace(/^"(.*)"$/, '$1')
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((a) => !/[*?!]/.test(a))
        .map((alias) => ({ alias }))
      out.push(...current)
      continue
    }
    if (key === 'match') {
      current = []
      continue
    }
    for (const h of current) {
      if (key === 'hostname') h.hostName ??= value
      else if (key === 'user') h.user ??= value
      else if (key === 'port') h.port ??= Number(value)
      else if (key === 'identityfile') h.identityFile ??= value
      else if (key === 'proxyjump') h.proxyJump ??= value
    }
  }
  return out
}

/** Build the tree structure for the session sidebar from folder paths. */
export interface FolderNode<T> {
  name: string
  path: string
  folders: FolderNode<T>[]
  items: T[]
}

/** Folder tree of `items` ("a/b" paths); `folders` adds folders that have no items (yet). */
export function buildTree<T extends { folder: string; name: string }>(items: T[], folders: string[] = []): FolderNode<T> {
  const root: FolderNode<T> = { name: '', path: '', folders: [], items: [] }
  const nodeAt = (path: string): FolderNode<T> => {
    let node = root
    const parts = path.split('/').filter(Boolean)
    parts.forEach((part, i) => {
      let child = node.folders.find((f) => f.name === part)
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), folders: [], items: [] }
        node.folders.push(child)
      }
      node = child
    })
    return node
  }
  for (const f of folders) nodeAt(f)
  for (const item of items) nodeAt(item.folder).items.push(item)
  const sort = (n: FolderNode<T>): void => {
    n.folders.sort((a, b) => a.name.localeCompare(b.name))
    n.items.sort((a, b) => a.name.localeCompare(b.name))
    n.folders.forEach(sort)
  }
  sort(root)
  return root
}

/** How a database opens: every folder closed except the first one at the top level. */
export function foldedExceptFirst<T extends { folder: string; name: string }>(items: T[], folders: string[] = []): Record<string, boolean> {
  const folded: Record<string, boolean> = {}
  const walk = (node: FolderNode<T>): void => {
    for (const f of node.folders) {
      folded[f.path] = true
      walk(f)
    }
  }
  const root = buildTree(items, folders)
  walk(root)
  if (root.folders[0]) delete folded[root.folders[0].path]
  return folded
}

/** Format a POSIX mode as "drwxr-xr-x". */
export function formatMode(mode: number, isDir: boolean): string {
  const chars = 'rwxrwxrwx'
  let s = isDir ? 'd' : '-'
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-'
  return s
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

export function joinRemote(dir: string, name: string): string {
  if (dir.endsWith('/')) return dir + name
  return `${dir}/${name}`
}

const multiExt = /\.(tar\.(gz|bz2|xz|zst)|tgz)$/i

/**
 * "report.pdf" → "report-48213.pdf", "logs.tar.gz" → "logs-48213.tar.gz", folders and dotfiles
 * get the number at the end. For "keep both" when a transfer would overwrite something.
 */
export function withRandomSuffix(name: string, isDir: boolean, rand = (): number => Math.floor(10000 + Math.random() * 90000)): string {
  const n = rand()
  const ext = isDir ? '' : (multiExt.exec(name)?.[0] ?? (/(?<=.)\.[^./]+$/.exec(name)?.[0] ?? ''))
  return `${name.slice(0, name.length - ext.length)}-${n}${ext}`
}

/** Last path segment, for both "/" and "\\" separators. */
export function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

export function parentRemote(path: string): string {
  if (path === '/' || !path) return '/'
  const trimmed = path.replace(/\/+$/, '')
  const idx = trimmed.lastIndexOf('/')
  return idx <= 0 ? '/' : trimmed.slice(0, idx)
}

/** Windows accounts can be typed as DOMAIN\user, which wins over the session's own domain. */
export function splitDomainUser(username: string, domain = ''): { username: string; domain: string } {
  const at = username.indexOf('\\')
  return at < 0 ? { username, domain } : { username: username.slice(at + 1), domain: username.slice(0, at) }
}

export interface PromptInfo {
  user: string
  /** absolute or ~-relative; null = a prompt that shows only the folder's last name */
  path: string | null
}

// user@host:/path$   user@host:~/path#   user@host /path %   [user@host /path]$   with an optional (venv) in front
const PROMPT = /^(?:\([^)]*\)\s*)*\[?([\w.-]+)@[\w.-]+(?::|\s+)([^#$%>\]]*?)\s*\]?\s*[#$%>]$/

/** Read the folder from the line under the cursor. Anything after the prompt (typed text) means no match. */
export function parsePrompt(line: string): PromptInfo | undefined {
  const m = PROMPT.exec(line.trim())
  if (!m) return undefined
  // A git branch or similar after the path: user@host:/path (main)$
  const path = m[2].replace(/\s+\([^)]*\)$/, '')
  if (!path) return undefined
  return { user: m[1], path: path === '~' || /^~?\//.test(path) ? path : null }
}

/** Where ~ points for `user`, seen from the home folder of the account SFTP logged in with. */
export function expandHome(path: string, user: string | undefined, home: string): string {
  if (!path.startsWith('~')) return path
  const base = home.replace(/\/+$/, '')
  const login = base.slice(base.lastIndexOf('/') + 1)
  // sudo -i and su change the shell's user, but not SFTP's.
  const userHome = !user || user === login ? base : user === 'root' ? '/root' : `${base.slice(0, base.lastIndexOf('/'))}/${user}`
  return (userHome + path.slice(1)) || '/'
}

export interface SshAddress {
  host: string
  port: number
  username: string
}

/** `host`, `user@host`, `user@host:2222`, `[::1]:2222`. undefined when it can't be an address. */
export function parseSshAddress(text: string): SshAddress | undefined {
  const m = /^(?:([^\s@]+)@)?(?:\[([0-9a-fA-F:.]+)\]|([^\s@:/[\]]+))(?::(\d+))?$/.exec(text.trim())
  if (!m) return undefined
  const port = m[4] ? Number(m[4]) : 22
  if (port < 1 || port > 65535) return undefined
  return { host: m[2] ?? m[3], port, username: m[1] ?? '' }
}

export function formatSshAddress({ host, port, username }: SshAddress): string {
  const name = host.includes(':') ? `[${host}]` : host
  return `${username ? username + '@' : ''}${name}${port !== 22 ? ':' + port : ''}`
}
