import { describe, expect, it } from 'vitest'
import { addToHistory, commandFromLine, commandToKeep, longerCommand, suggestRest } from '../src/shared/history'

describe('commandFromLine', () => {
  it('finds the command after common prompts', () => {
    expect(commandFromLine('root@box:~# nmap -sn 10.0.0.0/24')).toBe('nmap -sn 10.0.0.0/24')
    expect(commandFromLine('[me@box dir]$ ls -la')).toBe('ls -la')
    expect(commandFromLine('me@box /tmp % git status')).toBe('git status')
    expect(commandFromLine('(venv) me@box:~/x (main)$ pytest')).toBe('pytest')
    expect(commandFromLine('mysql> select 1;')).toBe('select 1;')
    expect(commandFromLine('PS C:\\Users\\me> dir')).toBe('dir')
    expect(commandFromLine('C:\\Users\\me>dir')).toBe('dir')
  })
  it('keeps redirects and later markers in the command', () => {
    expect(commandFromLine('$ echo a > b')).toBe('echo a > b')
    expect(commandFromLine('# echo $HOME')).toBe('echo $HOME')
  })
  it('gives nothing without a prompt, and an empty command on a bare one', () => {
    expect(commandFromLine('Enter your name: bob')).toBeUndefined()
    expect(commandFromLine('root@box:~#')).toBe('')
  })
})

describe('commandToKeep', () => {
  it('takes what the screen shows, not the keys', () => {
    expect(commandToKeep('$ systemctl status nginx', 'sys\tstatus nginx')).toBe('systemctl status nginx')
  })
  it('finishes a command whose echo is still coming', () => {
    expect(commandToKeep('$ nmap -', 'nmap -sn host')).toBe('nmap -sn host')
  })
  it('never keeps what was not echoed', () => {
    expect(commandToKeep('$', 'hunter2')).toBeUndefined()
    expect(commandToKeep('[sudo] password for me:', 'hunter2')).toBeUndefined()
    expect(commandToKeep('Password:', 'hunter2')).toBeUndefined()
    expect(commandToKeep('Enter passphrase> hunter2', 'hunter2')).toBeUndefined()
  })
  it('leaves out secrets, a leading space, and lines without a prompt', () => {
    expect(commandToKeep('$ mysql --password=hunter2', 'mysql --password=hunter2')).toBeUndefined()
    expect(commandToKeep('$ curl -H "Authorization: Bearer abcdef123456"', '')).toBeUndefined()
    expect(commandToKeep('$  echo private', ' echo private')).toBeUndefined()
    expect(commandToKeep('name: bob', 'bob')).toBeUndefined()
  })
  it('leaves out what is too short or too long', () => {
    expect(commandToKeep('$ l', 'l')).toBeUndefined()
    expect(commandToKeep(`$ ${'x'.repeat(501)}`, '')).toBeUndefined()
  })
})

describe('addToHistory', () => {
  it('moves a repeat to the newest place', () => {
    expect(addToHistory(['a', 'b', 'c'], 'a')).toEqual(['b', 'c', 'a'])
  })
  it('drops the oldest past the limit', () => {
    expect(addToHistory(['a', 'b', 'c'], 'd', 3)).toEqual(['b', 'c', 'd'])
  })
})

describe('suggestRest', () => {
  it('gives the rest of the newest match', () => {
    expect(suggestRest('git', ['git log', 'ls', 'git status'])).toBe(' status')
  })
  it('prefers the first list that has one', () => {
    expect(suggestRest('git', ['git log'], ['git status'])).toBe(' log')
    expect(suggestRest('git', ['ls'], ['git status'])).toBe(' status')
  })
  it('needs two letters, an exact start, and something to add', () => {
    expect(suggestRest('g', ['git log'])).toBeUndefined()
    expect(suggestRest('GIT', ['git log'])).toBeUndefined()
    expect(suggestRest('git log', ['git log'])).toBeUndefined()
  })
})

describe('longerCommand', () => {
  it('uses where the first key was pressed when no prompt is recognised', () => {
    expect(longerCommand(undefined, 'git status')).toBe('git status')
    expect(longerCommand(undefined, undefined)).toBeUndefined()
  })
  it('is not fooled by a > in the command', () => {
    expect(longerCommand('b', 'echo a > b')).toBe('echo a > b')
  })
  it('keeps the whole of a continued line', () => {
    expect(longerCommand('tar cf a b', 'b')).toBe('tar cf a b')
  })
})

describe('commandToKeep with the place the first key was pressed', () => {
  it('keeps commands behind a prompt it can not read', () => {
    expect(commandToKeep('➜  ~ git status', 'git status', 'git status')).toBe('git status')
  })
  it('still drops what looks like a secret', () => {
    expect(commandToKeep('➜  ~ export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789', '', 'export TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789')).toBeUndefined()
  })
  it('nothing echoed, nothing kept', () => {
    expect(commandToKeep('Enter key: ', 'hunter2', '')).toBeUndefined()
  })
})
