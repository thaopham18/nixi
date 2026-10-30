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
