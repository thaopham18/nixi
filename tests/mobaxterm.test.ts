import { existsSync, readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { decodeMobaFile, mobaMacroToSteps, mobaToSessions, parseMobaIni, sessionsToMoba } from '../src/shared/mobaxterm'
import { decryptMoba, encryptMobaForTest } from '../src/main/import/moba-crypto'

let n = 0
const id = (): string => `id${++n}`

const sample = [
  '[Bookmarks]',
  'SubRep=',
  'ImgNum=42',
  'web 1=#109#0%10.0.0.1%2222%deploy%%-1%0%sudo -i__PTVIRG__ ls%bastion.example.com%22%jump%0%0%0%_ProfileDir_\\.ssh\\id_rsa%%-1%-1%0%0%%1080%%0%0%1%%0%%%%0%-1%-1%0%%%0%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #255',
  '',
  '[Bookmarks_1]',
  'SubRep=Prod\\Windows',
  'ImgNum=41',
  'dc01=#91#4%10.0.0.5%3389%CORP\\admin%0%0%0%0%-1%0%0%-1%%%%%0%0%%-1%%-1%-1%0%-1%0%-1%0%0%0%0%#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%0%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1%0%#0# #-1',
  'wsl=#105#14%Ubuntu%%%#MobaFont#0# #-1',
  'core-sw=#98#1%10.0.0.254%2323%%%2%%%%%0%0%%1080%%0#MobaFont#0# #-1',
  '',
  '[Macros]',
  'F1-Hello=PLAIN',
  '[MacrosHotkeys]',
  'F1-Hello=1'
].join('\r\n')

describe('MobaXterm import', () => {
  const parsed = parseMobaIni(sample)

  it('parses bookmarks, folders and macros', () => {
    expect(parsed.bookmarks.map((b) => [b.name, b.folder, b.type])).toEqual([
      ['web 1', '', 0],
      ['dc01', 'Prod/Windows', 4],
      ['wsl', 'Prod/Windows', 14],
      ['core-sw', 'Prod/Windows', 1]
    ])
    expect(parsed.macros).toEqual([{ name: 'F1-Hello', value: 'PLAIN', hotkey: 'F1' }])
  })

  it('converts SSH, RDP and gateways to sessions', () => {
    const { sessions, unsupported } = mobaToSessions(parsed.bookmarks, id, '/Users/me')
    expect(unsupported).toEqual({ WSL: 1 })
    const gw = sessions.find((s) => s.name.startsWith('gateway'))!
    const web = sessions.find((s) => s.name === 'web 1')!
    expect(gw).toMatchObject({ host: 'bastion.example.com', port: 22, username: 'jump', folder: 'MobaXterm/_gateways' })
    expect(web).toMatchObject({
      type: 'ssh',
      folder: 'MobaXterm',
      host: '10.0.0.1',
      port: 2222,
      username: 'deploy',
      auth: 'key',
      privateKeyPath: '/Users/me/.ssh/id_rsa',
      startupCommand: 'sudo -i; ls',
      jumpSessionId: gw.id,
      color: '#ff0000'
    })
    expect(sessions.find((s) => s.name === 'core-sw')).toMatchObject({ type: 'telnet', host: '10.0.0.254', port: 2323 })
    expect(sessions.find((s) => s.name === 'dc01')).toMatchObject({
      type: 'rdp',
      folder: 'MobaXterm/Prod/Windows',
      host: '10.0.0.5',
      port: 3389,
      username: 'admin',
      rdpDomain: 'CORP'
    })
  })

  it('round-trips through the .mxtsessions export', () => {
    const { sessions } = mobaToSessions(parsed.bookmarks, id, '/Users/me')
    const { text, skipped } = sessionsToMoba([...sessions, { id: 'l', name: 'local', type: 'local', folder: '' }])
    expect(skipped).toBe(2) // local shell + Telnet (MobaXterm's Telnet layout is not documented)
    expect(text).toContain('\r\n[Bookmarks_1]\r\nSubRep=MobaXterm\r\n')
    const again = mobaToSessions(parseMobaIni(text).bookmarks, id, '/Users/me').sessions
    const strip = (list: typeof sessions) =>
      list.map(({ name, type, host, port, username, rdpDomain, startupCommand, color }) => ({ name, type, host, port, username, rdpDomain, startupCommand, color }))
    // Gateways are exported inline on the session that uses them, so they come back once more.
    expect(strip(again.filter((s) => !s.folder.includes('_gateways')))).toEqual(
      strip(sessions.filter((s) => !s.folder.includes('_gateways') && s.type !== 'telnet'))
    )
  })

  it('decodes CP1252 when the file is not UTF-8', () => {
    expect(decodeMobaFile(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café')
    expect(decodeMobaFile(Buffer.from('café', 'utf8'))).toBe('café')
  })
})

describe('MobaXterm macros', () => {
  it('converts plain and recorded text to send steps', () => {
    expect(mobaMacroToSteps('sudo -i\nwhoami')).toEqual([
      { kind: 'send', text: 'sudo -i\r' },
      { kind: 'send', text: 'whoami\r' }
    ])
    expect(mobaMacroToSteps('12:2:0:ls -la__PIPE__12:2:0:pwd')).toEqual([
      { kind: 'send', text: 'ls -la\r' },
      { kind: 'send', text: 'pwd\r' }
    ])
  })

  it('decrypts with the right master password only', () => {
    const enc = encryptMobaForTest('sudo su -\ndocker system prune -f', 'master-pw')
    expect(decryptMoba(enc, 'master-pw')).toBe('sudo su -\ndocker system prune -f')
    expect(decryptMoba(enc, 'wrong-pw')).toBeNull()
  })
})

// Optional: MOBA_INI=path/to/MobaXterm.ini npx vitest run tests/mobaxterm.test.ts
const realIni = process.env.MOBA_INI
describe.skipIf(!realIni || !existsSync(realIni))('real MobaXterm.ini', () => {
  it('parses every SSH/RDP bookmark into a usable session', () => {
    const parsed = parseMobaIni(decodeMobaFile(readFileSync(realIni!)))
    const { sessions, unsupported } = mobaToSessions(parsed.bookmarks, id, '/Users/me')
    const bad = sessions.filter((s) => !s.host || !s.port || Number.isNaN(s.port))
    console.log(
      `bookmarks=${parsed.bookmarks.length} sessions=${sessions.length} ssh=${sessions.filter((s) => s.type === 'ssh').length}` +
        ` rdp=${sessions.filter((s) => s.type === 'rdp').length} gateways=${sessions.filter((s) => s.folder.endsWith('_gateways')).length}` +
        ` folders=${new Set(sessions.map((s) => s.folder)).size} unsupported=${JSON.stringify(unsupported)} macros=${parsed.macros.length}` +
        ` hotkeys=${parsed.macros.filter((m) => m.hotkey).length} bad=${bad.length}`
    )
    expect(bad).toEqual([])
  })
})
