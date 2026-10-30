import { spawn } from 'child_process'
import { describe, expect, it } from 'vitest'
import { STATS_SCRIPT, StatsParser, formatBytes, formatUptime, fullestDisk, parseDf, splitDisks } from '../src/shared/stats'

const linuxBlock = (cpu: string, rx: number, tx: number): string =>
  [
    `cpu  ${cpu}`,
    'MemTotal:        8000000 kB',
    'MemFree:          500000 kB',
    'MemAvailable:    6000000 kB',
    'Buffers:          100000 kB',
    'Cached:          1000000 kB',
    'uptime 93784.21',
    'load 0.52 0.40 0.31',
    `net ${rx} ${tx}`,
    'disk 40000000 60000000',
    'users 2',
    '--',
    ''
  ].join('\n')

describe('StatsParser', () => {
  it('reads a Linux /proc block; CPU and network rates come from the second block', () => {
    const p = new StatsParser()
    const [first] = p.feed('host web-01\n' + linuxBlock('100 0 100 800 0 0 0 0 0 0', 1000, 500), 0)
    expect(first).toMatchObject({
      host: 'web-01',
      memTotal: 8000000 * 1024,
      memUsed: 2000000 * 1024,
      diskUsed: 40000000 * 1024,
      diskTotal: 100000000 * 1024,
      load: [0.52, 0.4, 0.31],
      uptime: 93784.21,
      users: 2
    })
    expect(first.cpu).toBeUndefined()
    expect(first.rx).toBeUndefined()
    // +100 busy, +100 idle jiffies → 50 %; +3000 / +1500 bytes in 3 s.
    const [second] = p.feed(linuxBlock('150 0 150 900 0 0 0 0 0 0', 4000, 2000), 3000)
    expect(second.cpu).toBeCloseTo(50)
    expect(second.rx).toBeCloseTo(1000)
    expect(second.tx).toBeCloseTo(500)
  })

  it('handles blocks split across chunks', () => {
    const p = new StatsParser()
    const text = linuxBlock('1 2 3 4', 1, 1)
    expect(p.feed(text.slice(0, 50))).toEqual([])
    expect(p.feed(text.slice(50))).toHaveLength(1)
  })

  it('reads the macOS / BSD fallback', () => {
    const p = new StatsParser()
    const [s] = p.feed(
      ['ncpu 8', 'pscpu 200', 'memtotal 17179869184', 'memavail 4294967296', 'boot 1000 4600', 'load  1.5 1.2 1.0 ', 'net 10 20', 'disk 100 300', 'users 1', '--', ''].join(
        '\n'
      )
    )
    expect(s).toMatchObject({ cpu: 25, memTotal: 17179869184, memUsed: 12884901888, uptime: 3600, load: [1.5, 1.2, 1], diskTotal: 400 * 1024 })
  })

  it('skips a network sample when counters go backwards', () => {
    const p = new StatsParser()
    p.feed(linuxBlock('1 0 1 1', 5000, 5000), 0)
    const [s] = p.feed(linuxBlock('2 0 2 2', 10, 10), 3000)
    expect(s.rx).toBeUndefined()
  })

  it('lists real filesystems from df, skipping virtual ones', () => {
    const p = new StatsParser()
    const [s] = p.feed(
      [
        'disk 10 90',
        'fs /dev/sda1        41152736 20576368 18463368  53% /',
        'fs tmpfs             1632048     1456  1630592   1% /run',
        'fs /dev/sdb1       103081248 51540624 46297896  53% /mnt/My Data',
        'fs /dev/loop3          65536    65536        0 100% /snap/core/123',
        'fs /dev/sda15         106858     6186   100673   6% /boot/efi',
        '--',
        ''
      ].join('\n')
    )
    expect(s.disks?.map((d) => d.mount)).toEqual(['/', '/boot/efi', '/mnt/My Data'])
    expect(s.disks?.[2]).toEqual({ mount: '/mnt/My Data', source: '/dev/sdb1', used: 51540624 * 1024, total: (51540624 + 46297896) * 1024 })
  })

  it('parses macOS df lines', () => {
    expect(parseDf('/dev/disk1s2   487260152  39969924 433473532     9%    /System/Volumes/Data')?.mount).toBe('/System/Volumes/Data')
    expect(parseDf('/dev/disk1s4   487260152   2097172 433473532     1%    /System/Volumes/VM')).toBeUndefined()
    expect(parseDf('map auto_home          0         0         0   100%    /System/Volumes/Data/home')).toBeUndefined()
    expect(parseDf('/dev/disk4s1     1000000    250000    750000    25%    /Volumes/USB Stick')?.total).toBe(1000000 * 1024)
  })

  it('formats sizes and uptime', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(8 * 1024 ** 3)).toBe('8.0 GB')
    expect(formatUptime(93784)).toBe('1d 2h')
    expect(formatUptime(3700)).toBe('1h 1m')
  })
})

describe('STATS_SCRIPT', () => {
  it.skipIf(process.platform === 'win32')('runs under sh on this machine and yields stats', async () => {
    const p = new StatsParser()
    const sh = spawn('sh', ['-s'])
    sh.stdin.end(STATS_SCRIPT)
    const blocks: ReturnType<StatsParser['feed']> = []
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no stats from the script')), 8000)
      sh.stdout.on('data', (d: Buffer) => {
        blocks.push(...p.feed(d.toString()))
        if (blocks.length >= 2) {
          clearTimeout(timer)
          resolve()
        }
      })
    }).finally(() => sh.kill())
    const s = blocks[1]
    expect(s.host).toBeTruthy()
    expect(s.cpu).toBeGreaterThanOrEqual(0)
    expect(s.memTotal).toBeGreaterThan(0)
    expect(s.memUsed).toBeGreaterThan(0)
    expect(s.diskTotal).toBeGreaterThan(0)
    expect(s.uptime).toBeGreaterThan(0)
    expect(s.load).toHaveLength(3)
    expect(s.rx).toBeGreaterThanOrEqual(0)
    expect(s.disks?.length).toBeGreaterThan(0)
  }, 10000)
})

describe('fullestDisk', () => {
  it('picks the disk with the highest use, larger one on a tie', () => {
    const d = (mount: string, used: number, total: number) => ({ mount, source: 'x', used, total })
    expect(fullestDisk([d('/', 50, 100), d('/var', 92, 100), d('/data', 10, 1000)])?.mount).toBe('/var')
    expect(fullestDisk([d('/a', 5, 10), d('/b', 50, 100)])?.mount).toBe('/b')
    expect(fullestDisk([])).toBeUndefined()
    expect(fullestDisk(undefined)).toBeUndefined()
  })
})

describe('splitDisks', () => {
  const d = (mount: string, used: number, total = 100) => ({ mount, source: 'x', used, total })
  it('keeps the user mounts, fullest first; boot / EFI go to the popup', () => {
    const r = splitDisks([d('/', 40), d('/boot', 90), d('/boot/efi', 5), d('/data', 85), d('/mnt/nas', 600, 1000)])
    expect(r.user.map((x) => x.mount)).toEqual(['/data', '/mnt/nas', '/'])
    expect(r.system.map((x) => x.mount)).toEqual(['/boot', '/boot/efi'])
  })
  it('macOS: the data volume is the user disk, / is the system snapshot', () => {
    const r = splitDisks([d('/', 3), d('/System/Volumes/Data', 9), d('/Volumes/USB', 50)])
    expect(r.user.map((x) => x.mount)).toEqual(['/Volumes/USB', '/System/Volumes/Data'])
    expect(r.system.map((x) => x.mount)).toEqual(['/'])
  })
  it('never leaves the bar empty', () => {
    expect(splitDisks([d('/boot', 10)]).user.map((x) => x.mount)).toEqual(['/boot'])
    expect(splitDisks(undefined)).toEqual({ user: [], system: [] })
  })
})
