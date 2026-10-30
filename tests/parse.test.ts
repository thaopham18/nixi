import { describe, expect, it } from 'vitest'
import { baseName, buildTree, formatMode, parentRemote, parseSshConfig, withRandomSuffix } from '../src/shared/parse'

describe('parseSshConfig', () => {
  it('reads concrete hosts and ignores wildcards', () => {
    const cfg = `
Host *
  User nobody
Host web prod-web # comment
  HostName 1.2.3.4
  User deploy
  Port 2200
  IdentityFile ~/.ssh/web
  ProxyJump bastion
Host bastion
  HostName=bastion.example.com
`
    const hosts = parseSshConfig(cfg)
    expect(hosts.map((h) => h.alias)).toEqual(['web', 'prod-web', 'bastion'])
    expect(hosts[0]).toMatchObject({ hostName: '1.2.3.4', user: 'deploy', port: 2200, identityFile: '~/.ssh/web', proxyJump: 'bastion' })
    expect(hosts[2].hostName).toBe('bastion.example.com')
  })
})

describe('buildTree', () => {
  it('nests folders and sorts', () => {
    const tree = buildTree([
      { name: 'b', folder: 'Prod/DB' },
      { name: 'a', folder: 'Prod/DB' },
      { name: 'root', folder: '' },
      { name: 'x', folder: 'Dev' }
    ])
    expect(tree.items.map((i) => i.name)).toEqual(['root'])
    expect(tree.folders.map((f) => f.name)).toEqual(['Dev', 'Prod'])
    expect(tree.folders[1].folders[0].path).toBe('Prod/DB')
    expect(tree.folders[1].folders[0].items.map((i) => i.name)).toEqual(['a', 'b'])
  })
})

describe('path helpers', () => {
  it('formats modes', () => {
    expect(formatMode(0o755, true)).toBe('drwxr-xr-x')
    expect(formatMode(0o640, false)).toBe('-rw-r-----')
  })
  it('finds parents', () => {
    expect(parentRemote('/home/user/')).toBe('/home')
    expect(parentRemote('/etc')).toBe('/')
    expect(parentRemote('/')).toBe('/')
  })
})

describe('buildTree with empty folders', () => {
  it('keeps folders that have no sessions', () => {
    const t = buildTree([{ name: 'a', folder: 'Prod' }], ['Lab/Switches', 'Prod'])
    expect(t.folders.map((f) => f.path)).toEqual(['Lab', 'Prod'])
    expect(t.folders[0].folders[0]).toMatchObject({ path: 'Lab/Switches', items: [] })
    expect(t.folders[1].items).toHaveLength(1)
  })
})

describe('withRandomSuffix', () => {
  const r = (): number => 48213
  it('puts 5 digits before the extension', () => {
    expect(withRandomSuffix('report.pdf', false, r)).toBe('report-48213.pdf')
    expect(withRandomSuffix('logs.tar.gz', false, r)).toBe('logs-48213.tar.gz')
    expect(withRandomSuffix('my.config.json', false, r)).toBe('my.config-48213.json')
  })
  it('appends to folders, dotfiles and names without extension', () => {
    expect(withRandomSuffix('backup.d', true, r)).toBe('backup.d-48213')
    expect(withRandomSuffix('.bashrc', false, r)).toBe('.bashrc-48213')
    expect(withRandomSuffix('Makefile', false, r)).toBe('Makefile-48213')
  })
  it('defaults to a random 5-digit number', () => {
    for (let i = 0; i < 20; i++) expect(withRandomSuffix('a.txt', false)).toMatch(/^a-\d{5}\.txt$/)
  })
})

describe('baseName', () => {
  it('handles both separators and trailing ones', () => {
    expect(baseName('/Users/me/file.txt')).toBe('file.txt')
    expect(baseName('C:\\Users\\me\\dir\\')).toBe('dir')
  })
})
