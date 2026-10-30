// Server resource monitor shown under SSH terminals (like MobaXterm's bottom bar).
// STATS_SCRIPT is fed to `sh -s` on its own exec channel: it prints one block of "key values" lines
// every few seconds, ended by "--". Linux reads /proc; other Unix (macOS, BSD) falls back to
// sysctl / vm_stat / ps. StatsParser turns blocks into ServerStats (rates need two blocks).

export interface ServerStats {
  host?: string
  /** 0–100, all cores */
  cpu?: number
  memUsed?: number
  memTotal?: number
  /** filesystem holding / (on macOS: the data volume) */
  diskUsed?: number
  diskTotal?: number
  /** every real local filesystem (hover table) */
  disks?: DiskInfo[]
  load?: [number, number, number]
  uptime?: number
  /** bytes per second, all interfaces but loopback */
  rx?: number
  tx?: number
  users?: number
}

export interface DiskInfo {
  mount: string
  source: string
  used: number
  total: number
}

export const STATS_INTERVAL_S = 3

export const STATS_SCRIPT = `
echo "host $(hostname 2>/dev/null)"
d=1
while :; do
  if [ -r /proc/stat ]; then
    head -n1 /proc/stat
    grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached):' /proc/meminfo
    echo "uptime $(cut -d' ' -f1 /proc/uptime)"
    echo "load $(cut -d' ' -f1-3 /proc/loadavg)"
    awk -F'[: ]+' 'NR>2 && $2!="lo" {rx+=$3; tx+=$11} END {print "net", rx+0, tx+0}' /proc/net/dev
  else
    echo "ncpu $(sysctl -n hw.ncpu 2>/dev/null)"
    ps -A -o %cpu= 2>/dev/null | awk '{s+=$1} END {print "pscpu", s+0}'
    echo "memtotal $(sysctl -n hw.memsize 2>/dev/null)"
    vm_stat 2>/dev/null | awk '/page size of/ {ps=$8} /^Pages (free|inactive|speculative):/ {gsub(/\\./,"",$NF); f+=$NF} END {print "memavail", f*ps}'
    echo "boot $(sysctl -n kern.boottime 2>/dev/null | sed 's/^{ sec = \\([0-9]*\\).*/\\1/') $(date +%s)"
    echo "load $(sysctl -n vm.loadavg 2>/dev/null | tr -d '{}')"
    netstat -ibn 2>/dev/null | awk 'NF==11 && $1!~/^lo/ && $3~/Link/ {rx+=$7; tx+=$10} END {print "net", rx+0, tx+0}'
  fi
  df -Pk / /System/Volumes/Data 2>/dev/null | awk 'END {print "disk", $3, $4}'
  # all mounts incl. NFS/CIFS shares, but never wait on a dead network mount; no timeout(1): local only
  if command -v timeout >/dev/null 2>&1; then timeout 3 df -Pk 2>/dev/null; else df -Pkl 2>/dev/null || df -Pk 2>/dev/null; fi | awk 'NR>1 {print "fs " $0}'
  echo "users $(who 2>/dev/null | wc -l)"
  echo "--"
  sleep $d
  d=${STATS_INTERVAL_S}
done
`

const num = (s: string | undefined): number | undefined => {
  const n = Number(s)
  return s !== undefined && s !== '' && Number.isFinite(n) ? n : undefined
}

export class StatsParser {
  private buf = ''
  private lines: string[] = []
  private host?: string
  private prevCpu?: { idle: number; total: number }
  private prevNet?: { rx: number; tx: number; at: number }

  /** Feed raw output; returns the stats of every block completed by this chunk. */
  feed(chunk: string, now = Date.now()): ServerStats[] {
    this.buf += chunk
    const parts = this.buf.split('\n')
    this.buf = parts.pop() ?? ''
    const out: ServerStats[] = []
    for (const raw of parts) {
      const line = raw.trim()
      if (line === '--') {
        out.push(this.block(this.lines, now))
        this.lines = []
      } else if (line.startsWith('host ')) this.host = line.slice(5).trim() || undefined
      else if (line) this.lines.push(line)
    }
    return out
  }

  private block(lines: string[], now: number): ServerStats {
    const kv = new Map<string, string[]>()
    const disks: DiskInfo[] = []
    for (const l of lines) {
      if (l.startsWith('fs ')) {
        const d = parseDf(l.slice(3))
        if (d && !disks.some((x) => x.mount === d.mount)) disks.push(d)
        continue
      }
      const [k, ...v] = l.split(/\s+/)
      kv.set(k.replace(/:$/, ''), v)
    }
    const get = (k: string, i = 0): number | undefined => num(kv.get(k)?.[i])
    const s: ServerStats = { host: this.host }

    // CPU: Linux gives cumulative jiffies (needs the previous block), others a ps snapshot.
    const cpu = kv.get('cpu')?.map(Number)
    if (cpu && cpu.length >= 4 && cpu.every(Number.isFinite)) {
      const idle = cpu[3] + (cpu[4] ?? 0)
      const total = cpu.slice(0, 8).reduce((a, b) => a + b, 0)
      if (this.prevCpu && total > this.prevCpu.total)
        s.cpu = clamp(100 * (1 - (idle - this.prevCpu.idle) / (total - this.prevCpu.total)))
      this.prevCpu = { idle, total }
    } else if (get('pscpu') !== undefined && get('ncpu')) {
      s.cpu = clamp(get('pscpu')! / get('ncpu')!)
    }

    // Memory: /proc/meminfo in kB; sysctl / vm_stat in bytes.
    const memTotalKb = get('MemTotal')
    if (memTotalKb) {
      const avail = get('MemAvailable') ?? (get('MemFree') ?? 0) + (get('Buffers') ?? 0) + (get('Cached') ?? 0)
      s.memTotal = memTotalKb * 1024
      s.memUsed = Math.max(0, memTotalKb - avail) * 1024
    } else if (get('memtotal') && get('memavail') !== undefined) {
      s.memTotal = get('memtotal')
      s.memUsed = Math.max(0, get('memtotal')! - get('memavail')!)
    }

    // df -P: used / available in 1K blocks; total as df's Use% counts it.
    const used = get('disk', 0)
    const avail = get('disk', 1)
    if (used !== undefined && avail !== undefined) {
      s.diskUsed = used * 1024
      s.diskTotal = (used + avail) * 1024
    }

    if (disks.length) s.disks = disks.sort((a, b) => a.mount.localeCompare(b.mount))

    const load = kv.get('load')?.slice(0, 3).map(Number)
    if (load?.length === 3 && load.every(Number.isFinite)) s.load = load as [number, number, number]
    s.uptime = get('uptime') ?? (get('boot') && get('boot', 1) ? get('boot', 1)! - get('boot')! : undefined)
    s.users = get('users')

    const rx = get('net', 0)
    const tx = get('net', 1)
    if (rx !== undefined && tx !== undefined) {
      const p = this.prevNet
      // Counters can reset (interface down/up): skip that sample rather than show nonsense.
      if (p && now > p.at && rx >= p.rx && tx >= p.tx) {
        s.rx = ((rx - p.rx) * 1000) / (now - p.at)
        s.tx = ((tx - p.tx) * 1000) / (now - p.at)
      }
      this.prevNet = { rx, tx, at: now }
    }
    return s
  }
}

// Virtual / system mounts nobody wants in a disk list.
const skipSource = /^(tmpfs|devtmpfs|udev|overlay|shm|none|devfs|proc|sysfs|cgroup2?|efivarfs|map\b|\/dev\/loop\d+)/
const skipMount = /^\/(snap|dev|sys|proc|run)(\/|$)|^\/System\/Volumes\/(?!Data$)|^\/private\/var\/vm/

/** One `df -Pk` line: "source blocks used avail cap% mount" (source and mount may contain spaces). */
export function parseDf(line: string): DiskInfo | undefined {
  const m = /^(.+?)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(\/.*)$/.exec(line.trim())
  if (!m) return undefined
  const [, source, , used, avail, mount] = m
  const total = (Number(used) + Number(avail)) * 1024
  if (!total || skipSource.test(source) || skipMount.test(mount)) return undefined
  return { mount, source, used: Number(used) * 1024, total }
}

export const diskPct = (d: DiskInfo): number => (d.total ? (100 * d.used) / d.total : 0)

// Mounts the OS manages itself (boot / EFI partitions, macOS system volumes).
const systemMount = /^\/(boot|efi|recovery)(\/|$)|^\/System\/Volumes\/(?!Data$)|^\/Library\/Developer\/CoreSimulator\//

/**
 * Split the disks for the stats bar: the user's own mounts (shown in the bar, fullest first) and
 * the system ones (only in the popup). macOS "/" is the sealed system snapshot when the data
 * volume is mounted separately.
 */
export function splitDisks(disks: DiskInfo[] | undefined): { user: DiskInfo[]; system: DiskInfo[] } {
  const all = disks ?? []
  const macData = all.some((d) => d.mount === '/System/Volumes/Data')
  const isSystem = (d: DiskInfo): boolean => systemMount.test(d.mount) || (macData && d.mount === '/')
  const user = all.filter((d) => !isSystem(d))
  if (!user.length) return { user: [...all].sort(byUse), system: [] }
  return { user: user.sort(byUse), system: all.filter(isSystem) }
}

const byUse = (a: DiskInfo, b: DiskInfo): number => diskPct(b) - diskPct(a) || b.total - a.total

/** The disk closest to full (ties: the larger one), shown in the stats bar. */
export function fullestDisk(disks: DiskInfo[] | undefined): DiskInfo | undefined {
  return disks?.reduce<DiskInfo | undefined>((a, d) => (!a || diskPct(d) > diskPct(a) || (diskPct(d) === diskPct(a) && d.total > a.total) ? d : a), undefined)
}

const clamp = (n: number): number => Math.min(100, Math.max(0, n))

/** 1536 → "1.5 KB" (binary units, like top / free -h). */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/** 93784 → "1d 2h", 3700 → "1h 1m". */
export function formatUptime(s: number): string {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
