import { describe, expect, it } from 'vitest'
import { baseName, buildTree, expandHome, foldedExceptFirst, formatMode, formatSshAddress, parentRemote, parsePrompt, parseSshAddress, parseSshConfig, withRandomSuffix, splitDomainUser } from '../src/shared/parse'

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

describe('splitDomainUser', () => {
  it('keeps the session domain for a plain username', () => {
    expect(splitDomainUser('alice', 'CORP')).toEqual({ username: 'alice', domain: 'CORP' })
    expect(splitDomainUser('alice@corp.local')).toEqual({ username: 'alice@corp.local', domain: '' })
  })
  it('lets a typed DOMAIN\\user win', () => {
    expect(splitDomainUser('LAB\\bob', 'CORP')).toEqual({ username: 'bob', domain: 'LAB' })
    expect(splitDomainUser('.\\admin')).toEqual({ username: 'admin', domain: '.' })
  })
  it('leaves an empty username empty', () => {
    expect(splitDomainUser('', 'CORP')).toEqual({ username: '', domain: 'CORP' })
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

describe('foldedExceptFirst', () => {
  const at = (folder: string) => ({ folder, name: 's' })

  it('closes every folder but the first at the top level, and that one\'s subfolders', () => {
    expect(foldedExceptFirst([at('Prod/DB'), at('Dev'), at('')], ['Lab/Empty'])).toEqual({ Lab: true, 'Lab/Empty': true, Prod: true, 'Prod/DB': true })
    expect(foldedExceptFirst([at('Alpha/One'), at('Beta')])).toEqual({ 'Alpha/One': true, Beta: true })
  })

  it('has nothing to close without folders', () => {
    expect(foldedExceptFirst([at('')])).toEqual({})
    expect(foldedExceptFirst([])).toEqual({})
  })
})

describe('baseName', () => {
  it('handles both separators and trailing ones', () => {
    expect(baseName('/Users/me/file.txt')).toBe('file.txt')
    expect(baseName('C:\\Users\\me\\dir\\')).toBe('dir')
  })
})

describe('parsePrompt', () => {
  it.each([
    ['root@web-192-168-1-10:/home/alice/dns#', 'root', '/home/alice/dns'],
    ['alice@web-192-168-1-10:~$', 'alice', '~'],
    ['me@host:~/app/src$ ', 'me', '~/app/src'],
    ['me@host:/$', 'me', '/'],
    ['(venv) me@host:/srv/app$', 'me', '/srv/app'],
    ['(base) (venv) me@host:~/x$', 'me', '~/x'],
    ['me@host:/srv/app (main)$', 'me', '/srv/app'],
    ['me@host:/my dir/x$', 'me', '/my dir/x'],
    ['[me@host /etc/nginx]$', 'me', '/etc/nginx'],
    ['[root@host ~]#', 'root', '~'],
    ['me@host /srv %', 'me', '/srv'],
    ['me@host:/srv>', 'me', '/srv']
  ])('reads %s', (line, user, path) => {
    expect(parsePrompt(line)).toEqual({ user, path })
  })

  it.each(['[root@host dns]#', 'me@Mac dns %', 'me@host nginx $'])('knows %s shows only the last name', (line) => {
    expect(parsePrompt(line)?.path).toBeNull()
  })

  it.each([
    'me@host:/srv$ ls -la',
    'me@host:/srv$ echo $',
    'me@host:/srv$ echo a #',
    'total 48',
    'drwxr-xr-x 5 root root 4096 Nov 3 logs',
    'Password:',
    '$',
    '#',
    'mysql>',
    'bash-5.1$',
    'Switch#',
    'see me@host for details',
    'mail me@host.com',
    ''
  ])('does not take %s for a prompt with a folder', (line) => {
    expect(parsePrompt(line)).toBeUndefined()
  })
})

describe('expandHome', () => {
  it('leaves absolute paths alone', () => {
    expect(expandHome('/etc', 'root', '/home/me')).toBe('/etc')
  })

  it('uses the SFTP home for the same user', () => {
    expect(expandHome('~', 'me', '/home/me')).toBe('/home/me')
    expect(expandHome('~/app', 'me', '/home/me')).toBe('/home/me/app')
    expect(expandHome('~/app', undefined, '/home/me')).toBe('/home/me/app')
  })

  it('knows the shell may have changed user with sudo or su', () => {
    expect(expandHome('~', 'root', '/home/me')).toBe('/root')
    expect(expandHome('~/x', 'root', '/home/me')).toBe('/root/x')
    expect(expandHome('~/x', 'bob', '/home/me')).toBe('/home/bob/x')
    expect(expandHome('~', 'root', '/root')).toBe('/root')
    expect(expandHome('~/x', 'me', '/home/me/')).toBe('/home/me/x')
  })
})

describe('parseSshAddress', () => {
  it('reads what people type', () => {
    expect(parseSshAddress('db.example.com')).toEqual({ host: 'db.example.com', port: 22, username: '' })
    expect(parseSshAddress('  alice@10.0.0.5 ')).toEqual({ host: '10.0.0.5', port: 22, username: 'alice' })
    expect(parseSshAddress('alice@host:2222')).toEqual({ host: 'host', port: 2222, username: 'alice' })
    expect(parseSshAddress('[::1]:2222')).toEqual({ host: '::1', port: 2222, username: '' })
    expect(parseSshAddress('bob@[fe80::1]')).toEqual({ host: 'fe80::1', port: 22, username: 'bob' })
  })

  it('refuses what cannot be an address', () => {
    for (const text of ['', ' ', 'two words', 'a@b@c', 'host:0', 'host:70000', 'host:abc', 'ssh://host', '::1', '[oops]', '@host'])
      expect(parseSshAddress(text)).toBeUndefined()
  })

  it('writes it back the same way', () => {
    for (const text of ['host', 'alice@host', 'alice@host:2222', '[::1]:2222', 'bob@[fe80::1]']) expect(formatSshAddress(parseSshAddress(text)!)).toBe(text)
  })
})
