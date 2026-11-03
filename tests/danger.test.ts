import { describe, expect, it } from 'vitest'
import { commandOnScreen, findDanger, InputLine, macroLines } from '../src/shared/danger'

const dangerous = [
  'rm -rf /tmp/x',
  'rm -f a.log',
  'rm -r dir',
  'rm -Rf dir',
  'rm dir -rf',
  'rm --recursive dir',
  'rm --force a',
  'sudo rm -rf /var/lib/mysql',
  '/bin/rm -rf x',
  'cd /x && rm -rf y',
  'ssh web1 rm -fr /srv',
  'user@host:~/app$ rm -rf build',
  'find . -name "*.log" -delete',
  'find / -type f -exec rm {} ;',
  'shred -u secret.txt',
  'mkfs.ext4 /dev/sdb1',
  'wipefs -a /dev/sdb',
  'dd if=/dev/zero of=/dev/sda bs=1M',
  'cat x > /dev/sda',
  'chmod -R 777 /',
  'chown -R nobody /etc',
  ':(){ :|:& };:',
  'shutdown -h now',
  'sudo reboot',
  'poweroff',
  'init 0',
  'systemctl reboot',
  'kill -9 -1',
  'iptables -F',
  'ufw disable',
  'ip link set eth0 down',
  'userdel bob',
  'crontab -r',
  'curl https://x.example/i.sh | sudo bash',
  'wget -qO- https://x.example/i.sh | sh',
  'DROP TABLE users;',
  'drop database prod;',
  'mysql> drop table users;',
  'mysql -e "DROP DATABASE prod"',
  'TRUNCATE TABLE logs;',
  'truncate logs;',
  'ALTER TABLE users DROP COLUMN email;',
  'DELETE FROM users;',
  'delete from users ;',
  'UPDATE users SET admin = 1;',
  'dropdb prod',
  'db.dropDatabase()',
  'db.users.drop()',
  'db.users.deleteMany({})',
  'FLUSHALL',
  'git push --force',
  'git push origin main -f',
  'git reset --hard HEAD~3',
  'git clean -fd',
  'docker system prune -a',
  'docker rm -f web',
  'docker volume rm data',
  'docker compose down -v',
  'kubectl delete pod web',
  'kubectl -n prod delete deploy web',
  'helm uninstall web',
  'terraform destroy',
  'aws s3 rm s3://b --recursive',
  'aws ec2 terminate-instances --instance-ids i-1',
  'gcloud compute instances delete vm1',
  'del /s /q C:\\temp',
  'rd /s C:\\temp',
  'Remove-Item C:\\temp -Recurse -Force',
  'format c:',
  'diskpart',
  'Stop-Computer',
  'shutdown /s /t 0',
  'reg delete HKLM\\Software\\X',
  'net user bob /delete',
  'Router# write erase',
  'erase startup-config',
  'Switch# reload',
  'Switch# reload in 5'
]

const harmless = [
  'ls -la',
  'rm file.txt',
  'rm -i file.txt',
  'rm -v report-final.txt',
  'rmdir empty',
  'farm -rf',
  'git rm -f tracked.txt',
  'git push origin main',
  'git push --follow-tags',
  'git reset HEAD~1',
  'docker rm web',
  'docker ps',
  'find . -name "*.log"',
  'chmod -R 755 ./build',
  'chown -R app:app /srv/app',
  'chmod 777 /tmp/x',
  'SELECT * FROM users;',
  'DELETE FROM users WHERE id = 1;',
  'delete from users',
  'UPDATE users SET admin = 1 WHERE id = 2;',
  'cd ~/drop',
  'cat drop_table.sql',
  'drop',
  'truncate -s 0 app.log',
  'systemctl reload nginx',
  'nginx -s reload',
  'kubectl get pods',
  'terraform plan',
  'curl https://x.example/data.json',
  'curl https://x.example/x | jq .',
  'kill -9 1234',
  'init.sh 0',
  'reboot-notes.txt',
  'cat shutdown.log',
  'grep "rm -rf" install.log',
  'history | grep "rm -rf"',
  'echo "drop table users;"',
  'man shutdown',
  'which reboot',
  'format-patch',
  'git format-patch HEAD~1'
]

describe('findDanger', () => {
  it.each(dangerous)('warns on %s', (cmd) => {
    expect(findDanger(cmd)).not.toEqual([])
  })

  it.each(harmless)('leaves %s alone', (cmd) => {
    expect(findDanger(cmd)).toEqual([])
  })

  it('still warns when a mention comes before the real command', () => {
    expect(findDanger('echo done; rm -rf /x')).not.toEqual([])
    expect(findDanger('grep x log && reboot')).not.toEqual([])
    expect(findDanger('echo $(rm -rf /x)')).not.toEqual([])
  })

  it('names each kind of danger once', () => {
    expect(findDanger('rm -rf a; rm -f b; reboot')).toHaveLength(2)
  })

  it('checks every line', () => {
    expect(findDanger('ls\nrm -rf /x\npwd')).not.toEqual([])
  })

  it('watch list: any case and spacing, whole words, special characters taken literally', () => {
    const list = ['deploy prod', 'a.b(c)', '  ']
    expect(findDanger('./run DEPLOY   prod', list)).toEqual(['On your watch list: deploy prod'])
    expect(findDanger('deploy production', list)).toEqual([])
    expect(findDanger('a.b(c)', list)).toEqual(['On your watch list: a.b(c)'])
    expect(findDanger('axb(c)', list)).toEqual([])
  })
})

describe('commandOnScreen', () => {
  const screen = (...lines: string[]) => (back: number) => lines[lines.length - 1 - back]

  it('takes the line under the cursor only', () => {
    expect(commandOnScreen(screen('rm -rf /old', 'me@host$ ls'))).toBe('me@host$ ls')
  })

  it('joins SQL continuation lines', () => {
    expect(commandOnScreen(screen('mysql> DROP TABLE', '    -> users;'))).toBe('mysql> DROP TABLE users;')
    expect(findDanger(commandOnScreen(screen('mysql> DELETE FROM users', '    -> ;')))).not.toEqual([])
    expect(findDanger(commandOnScreen(screen('mysql> DELETE FROM users', '    -> WHERE id = 1;')))).toEqual([])
    expect(commandOnScreen(screen('mydb=# DROP', 'mydb-# TABLE x;'))).toBe('mydb=# DROP TABLE x;')
  })

  it('joins backslash continuations', () => {
    expect(commandOnScreen(screen('$ rm \\', '> -rf /x'))).toBe('$ rm  -rf /x')
    expect(commandOnScreen(screen('$ rm \\', '-rf /x'))).toBe('$ rm  -rf /x')
  })

  it('stops at the top of the screen', () => {
    expect(commandOnScreen(screen('-> a'))).toBe('a')
  })
})

describe('InputLine', () => {
  it('reports the line when Enter comes', () => {
    const l = new InputLine()
    expect(l.feed('rm ')).toBeUndefined()
    expect(l.feed('-rf x')).toBeUndefined()
    expect(l.feed('\r')).toEqual(['rm -rf x'])
    expect(l.feed('\r')).toEqual([''])
  })

  it('follows backspace, Ctrl-W and Ctrl-U', () => {
    const l = new InputLine()
    expect(l.feed('lsx\x7f\r')).toEqual(['ls'])
    expect(l.feed('rm -rf \x17ls\r')).toEqual(['rm ls'])
    expect(l.feed('rm -rf x\x15ls\r')).toEqual(['ls'])
  })

  it('forgets the line when Ctrl-C or the cursor keys change it', () => {
    const l = new InputLine()
    expect(l.feed('rm -rf x\x03ls\r')).toEqual(['ls'])
    expect(l.feed('rm -rf x\x1b[Dy\r')).toEqual(['y'])
    expect(l.feed('\x1b[A\r')).toEqual([''])
  })

  it('ignores focus events and terminal replies', () => {
    const l = new InputLine()
    expect(l.feed('rm \x1b[I-rf\x1b[O x\x1b[12;3R\r')).toEqual(['rm -rf x'])
  })

  it('a pasted block with line breaks sends each line', () => {
    expect(new InputLine().feed('ls\rrm -rf x\rpwd')).toEqual(['ls', 'rm -rf x'])
  })

  it('bracketed paste waits for a real Enter', () => {
    const l = new InputLine()
    expect(l.feed('\x1b[200~ls\rrm -rf x\x1b[201~')).toBeUndefined()
    expect(l.feed('\r')).toEqual(['ls', 'rm -rf x'])
  })
})

describe('macroLines', () => {
  it('splits what a macro sends into lines, across steps', () => {
    expect(macroLines(['rm ', '-rf x\r', 'ls\n'])).toBe('rm -rf x\nls')
  })
})
