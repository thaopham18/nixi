// Choosing an AI: models from the provider's own list, Gemini and any OpenAI-style server, against a
// fake API and a real local shell. What matters most: keys and text only reach the provider in use,
// and nothing runs by itself or from a cut-off answer, whichever provider it is. POSIX shells only.
//   npm run build && node scripts/e2e-ai-providers.mjs
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { _electron as electron } from 'playwright-core'
import { startFakeAi } from './dev-ai-server.mjs'

let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${detail}`)
  if (!ok) failed++
}

const SAVED_PASSWORD = 'Sup3rSavedPw77'
const CLAUDE_KEY = 'sk-ant-e2e-claude-key-0123456789'
const GEMINI_KEY = 'AIza-e2e-gemini-key-0123456789'
const CUSTOM_KEY = 'custom-e2e-key-0123456789'

const userData = mkdtempSync(join(tmpdir(), 'nixi-e2e-aip-'))
const work = mkdtempSync(join(tmpdir(), 'nixi-e2e-aip-work-'))
const path = (name) => join(work, name)
writeFileSync(join(userData, 'sessions.json'), JSON.stringify([{ id: 'local', name: 'local-box', type: 'local', folder: '', shell: '/bin/bash' }]))
writeFileSync(join(userData, 'secrets.json'), JSON.stringify({ local: 'raw:' + Buffer.from(SAVED_PASSWORD).toString('base64') }))

const fake = await startFakeAi()
const { state } = fake
const BASE = `http://127.0.0.1:${fake.port}`
const app = await electron.launch({ args: ['.'], env: { ...process.env, NIXI_USER_DATA: userData, NIXI_TEST_PASSWORD: 'e2e-master', NIXI_AI_BASE_URL: BASE } })
try {
  const win = await app.firstWindow()
  await win.waitForSelector('.tree-row')
  const wait = (ms = 300) => win.waitForTimeout(ms)
  const poll = async (fn, ms = 8000) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      if (await fn()) return true
      await wait(100)
    }
    return false
  }
  const panel = win.locator('.ai-panel')
  const box = win.locator('textarea[name=aiMessage]')
  const danger = win.locator('.modal', { hasText: 'Dangerous command' })
  const keyField = win.locator('input[name=aiKey]')
  const modelSelect = win.locator('select[name=aiModel]')
  const pageText = () => win.locator('.settings-content').innerText()
  const stopButton = win.locator('.ai-composer button', { hasText: 'Stop' })
  const idle = () => poll(async () => (await stopButton.count()) === 0)
  const lastProposal = () => win.locator('.ai-proposal').last()
  const runButton = () => lastProposal().locator('button', { hasText: 'Run' })
  const send = async (text) => {
    await box.fill(text)
    await win.locator('.ai-composer button', { hasText: 'Send' }).click()
  }
  const lastAi = () => state.openai[state.openai.length - 1]
  const lastClaude = () => state.requests[state.requests.length - 1]
  const hears = (n) => poll(async () => state.openai.length >= n && (await stopButton.count()) === 0)
  const skip = async () => {
    await lastProposal().locator('button', { hasText: 'Skip' }).click()
  }
  const openSettings = async () => {
    await win.locator('.toolbar button[title=Settings]').click()
    await win.locator('.settings-nav button', { hasText: 'AI Assistant' }).click()
  }
  const provider = (name) => win.locator('.settings-page:visible .type-picker button', { hasText: name }).click()
  const saveSettings = async () => {
    await win.locator('.modal-footer button.primary').click()
    await wait()
  }
  const options = () => modelSelect.locator('option').allInnerTexts()
  const noticeHas = (text) => poll(async () => (await panel.locator('.ai-notice', { hasText: text }).count()) > 0)

  await win.locator('.tree-row', { hasText: 'local-box' }).dblclick()
  await wait(1200)
  await win.locator('.sidebar-tabs button', { hasText: 'AI' }).click()

  console.log('--- models come from the provider')
  await panel.locator('button', { hasText: 'Add API key' }).click()
  await keyField.waitFor()
  check('no key yet: the list of known models is shown, nothing asked', state.modelChecks.length === 0 && (await options()).includes('Claude Opus 5.5'))
  await keyField.fill(CLAUDE_KEY)
  await win.locator('.settings-page:visible button', { hasText: 'Save key' }).click()
  await box.waitFor({ timeout: 3000 })
  await openSettings()
  check('a model newer than this app shows up by itself', await poll(async () => (await options()).includes('Claude New 9')), (await options()).join(','))
  check('it costs no tokens', state.requests.length === 0)
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-aip-anthropic.png') })
  await modelSelect.selectOption('claude-new-9')
  await saveSettings()
  await send('hello new model')
  await poll(() => state.requests.length === 1)
  await idle()
  check('…and can be used', lastClaude().body.model === 'claude-new-9')
  check('the panel says which model it is', (await win.locator('.ai-meta .ai-model').innerText()).includes('claude-new-9'))

  await openSettings()
  await poll(async () => (await options()).includes('Claude New 9'))
  await modelSelect.selectOption({ label: 'Other, type its name…' })
  await win.locator('input[name=aiModelName]').fill('claude-gone')
  await saveSettings()
  await send('to a retired model')
  check('a retired model: says so', await noticeHas('no such model'))
  await box.fill('')
  await panel.locator('.ai-notice button', { hasText: 'Open Settings' }).last().click()
  await modelSelect.waitFor()
  await wait()
  check('…and its button lands on the model', (await win.evaluate(() => document.activeElement?.getAttribute('name'))) === 'aiModel')
  check('a name not in the list stays shown', (await win.locator('input[name=aiModelName]').inputValue()) === 'claude-gone')
  await poll(async () => (await options()).includes('Claude New 9'))
  await modelSelect.selectOption('claude-new-9')
  check('…and picking from the list hides it again', (await win.locator('input[name=aiModelName]').count()) === 0)
  await saveSettings()

  await openSettings()
  state.failModels = true
  await win.locator('.settings-page:visible button', { hasText: 'Refresh' }).click()
  check('the list can not be fetched: says so', await poll(async () => (await pageText()).includes('Could not get the list')))
  check('…and offers the models it knows', (await options()).includes('Claude Opus 5.5'))
  state.failModels = false
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
  await wait()

  console.log('--- gemini')
  await openSettings()
  const claudeChecks = state.modelChecks.length
  await provider('Gemini')
  await wait(500)
  check('its own key field, empty', !(await pageText()).includes('(saved)') && (await pageText()).includes('Gemini API key'))
  check('the Claude key is not offered to it', state.modelChecks.length === claudeChecks && state.openai.length === 0)
  await keyField.fill('bad-key')
  await win.locator('.settings-page:visible button', { hasText: 'Test key' }).click()
  check('Test key reports a rejected key', await poll(async () => (await pageText()).includes('did not accept')))
  await keyField.fill(GEMINI_KEY)
  await win.locator('.settings-page:visible button', { hasText: 'Test key' }).click()
  check('Test key accepts a good one', await poll(async () => (await pageText()).includes('This key works')))
  await win.locator('.settings-page:visible button', { hasText: 'Save key' }).click()
  check('its models arrive, for chat only', await poll(async () => (await options()).includes('gemini-new-9')), (await options()).join(','))
  check('…without speech or embedding models', !(await options()).some((o) => /tts|embedding|^models\//.test(o)))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-aip-gemini.png') })
  await modelSelect.selectOption('gemini-new-9')
  await saveSettings()
  const check1 = state.modelChecks.filter((c) => c.url.includes('openai')).pop()
  check('the list was asked for with the Gemini key', check1?.key === GEMINI_KEY)

  const claudeBefore = state.requests.length
  await send('hello gemini')
  await hears(1)
  check('it answers', await poll(async () => (await panel.locator('.ai-msg.assistant', { hasText: 'Hello from fake v1beta/openai' }).count()) === 1))
  check('goes to the Gemini address with the Gemini key', lastAi().api === 'v1beta/openai' && lastAi().key === GEMINI_KEY && lastAi().body.model === 'gemini-new-9')
  check('Claude is not asked, and its key is not sent', state.requests.length === claudeBefore && !lastAi().raw.includes(CLAUDE_KEY))
  check('a new conversation: nothing of the old one goes along', lastAi().body.messages.length === 2 && lastAi().body.messages[0].role === 'system' && !lastAi().raw.includes('hello new model'))
  check('…and the user is told', await noticeHas('new conversation'))
  check('the system prompt and the one tool go along', lastAi().body.messages[0].content.includes('terminal_output') && lastAi().body.tools[0].function.name === 'propose_command')
  check('tokens are counted', (await win.locator('.ai-meta').innerText()).includes('77 tokens'))

  await send(`my keys are ${CLAUDE_KEY} and ${GEMINI_KEY} and ${SAVED_PASSWORD}`)
  await hears(2)
  check('saved keys and passwords are hidden in what is sent', !lastAi().raw.includes(CLAUDE_KEY) && !lastAi().raw.includes(GEMINI_KEY) && !lastAi().raw.includes(SAVED_PASSWORD))

  const touched = path('touched')
  let n = state.openai.length
  await send(`TOOL:touch ${touched}`)
  await hears(n + 1)
  await wait(500)
  check('a proposal is a card, and nothing runs', !existsSync(touched) && (await runButton().count()) === 1)
  await runButton().click()
  check('Run runs it', await poll(() => existsSync(touched)))
  await poll(async () => (await lastProposal().locator('.ai-review').count()) === 1)
  check('…nothing goes back until the user says', state.openai.length === n + 1)
  await lastProposal().locator('button', { hasText: 'Send to AI' }).click()
  await hears(n + 2)
  const msgs = lastAi().body.messages
  const call = msgs.findLast((m) => m.role === 'assistant').tool_calls[0]
  const result = msgs[msgs.length - 1]
  check('the command comes back whole', JSON.parse(call.function.arguments).command === `touch ${touched}`)
  check('the signature comes back unchanged', call.extra_content?.google?.thought_signature === 'gemini-signature-kept-as-is')
  check('the output answers that call', result.role === 'tool' && result.tool_call_id === call.id && result.content.includes('terminal_output'))
  await idle()

  n = state.openai.length
  await send('TOOL:rm -f ' + path('nothing'))
  await hears(n + 1)
  await wait(400)
  await runButton().click()
  await danger.waitFor({ timeout: 5000 })
  check('rm brings up the dangerous command warning', true)
  await danger.locator('button', { hasText: 'Cancel' }).click()
  await wait(300)
  await skip()
  await hears(n + 2)
  check('Skip answers the call', lastAi().body.messages[lastAi().body.messages.length - 1].content.includes('chose not to run'))

  console.log('--- gemini: when things go wrong')
  n = state.openai.length
  const cards = () => win.locator('.ai-proposal').count()
  let c = await cards()
  await send('BADJSON please')
  await hears(n + 2)
  check('tool input that is not JSON: no card, and the model hears why', (await cards()) === c && lastAi().body.messages[lastAi().body.messages.length - 1].content.includes('Invalid input'))
  await idle()
  c = await cards()
  await send('CUTTOOL please')
  check('cut off inside a command: no card', (await noticeHas('cut off')) && (await cards()) === c)
  await box.fill('')
  await send('REFUSE please')
  check('a content filter: no partial answer stays', (await noticeHas('declined')) && !(await panel.innerText()).includes('must go away'))
  await box.fill('')
  c = await cards()
  await send('DROP please')
  check('connection lost: says so, no card', (await noticeHas('ended before')) && (await cards()) === c)
  await box.fill('')
  await send('ERR401 please')
  check('401: says so, and hides the key if the server repeats it', (await noticeHas('did not accept')) && !(await panel.innerText()).includes(GEMINI_KEY))
  await box.fill('')
  await send('ERR429 please')
  check('429: says so', await noticeHas('rate limit'))
  await box.fill('')
  await send('ERR404 please')
  check('404: says so', await noticeHas('no such model'))
  await box.fill('')
  await send('SLOW please')
  await poll(async () => (await panel.innerText()).includes('slow1'))
  await stopButton.click()
  check('Stop stops it', await idle())
  n = state.openai.length
  await send('still works')
  check('…and the chat goes on', await hears(n + 1))

  console.log('--- gemini: Auto')
  await openSettings()
  await win.locator('input[name=aiAutoRun]').check()
  await saveSettings()
  n = state.openai.length
  await send('TOOL:uname')
  check('a command that only reads runs by itself, and its output goes back', await hears(n + 2))
  check('…told it finished', lastAi().body.messages[lastAi().body.messages.length - 1].content.includes('prompt came back'))
  const autoTouched = path('auto-touched')
  n = state.openai.length
  await send(`TOOL:touch ${autoTouched}`)
  await hears(n + 1)
  await wait(800)
  check('one that writes waits for Run', !existsSync(autoTouched) && (await runButton().count()) === 1)
  await skip()
  await hears(n + 2)
  await openSettings()
  await win.locator('input[name=aiAutoRun]').uncheck()
  await saveSettings()

  console.log('--- moving away while a card waits')
  n = state.openai.length
  await send('TOOL:uname')
  await hears(n + 1)
  await wait(400)
  await runButton().click()
  await poll(async () => (await lastProposal().locator('.ai-review').count()) === 1)
  await openSettings()
  await provider('Anthropic')
  await saveSettings()
  const claudeAt = state.requests.length
  await lastProposal().locator('button', { hasText: 'Send to AI' }).click()
  await wait(800)
  check('the output goes to neither provider', state.openai.length === n + 1 && state.requests.length === claudeAt)
  check('…and the user is told', (await panel.locator('.ai-notice', { hasText: 'new conversation' }).count()) >= 2)
  await send('back with Claude')
  await poll(() => state.requests.length === claudeAt + 1)
  await idle()
  check('back on Claude: its own key and format', lastClaude().key === CLAUDE_KEY && lastClaude().body.messages.length === 1 && lastClaude().body.model === 'claude-new-9')

  console.log('--- custom server')
  await openSettings()
  await provider('Custom')
  const address = win.locator('input[name=aiBaseUrl]')
  await address.fill('http://api.example.com/v1')
  check('plain http to the internet is refused', await poll(async () => (await pageText()).includes('unencrypted')))
  await address.fill('api.example.com')
  check('an address with no scheme is refused', await poll(async () => (await pageText()).includes('full address')))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-aip-custom.png') })
  await address.fill(`${BASE}/custom/v1/chat/completions`)
  await address.blur()
  check('its models arrive, with no key at all', await poll(async () => (await options()).includes('local-1')), await pageText())
  check('…and no key is sent', state.modelChecks[state.modelChecks.length - 1].key === undefined)
  await modelSelect.selectOption('local-2')
  await saveSettings()
  n = state.openai.length
  await send('hello custom')
  await hears(n + 1)
  check('it answers, on the cleaned-up address', lastAi().api === 'custom/v1' && lastAi().body.model === 'local-2')
  check('no key, and no other provider’s', lastAi().key === undefined && !lastAi().raw.includes(GEMINI_KEY) && !lastAi().raw.includes(CLAUDE_KEY))
  const customFile = path('custom-touched')
  n = state.openai.length
  await send(`TOOL:touch ${customFile}`)
  await hears(n + 1)
  await wait(500)
  check('a server that never says tool_calls still makes a card', (await runButton().count()) === 1 && !existsSync(customFile))
  await skip()
  await hears(n + 2)

  await openSettings()
  await keyField.fill(CUSTOM_KEY)
  await win.locator('.settings-page:visible button', { hasText: 'Save key' }).click()
  await wait()
  await saveSettings()
  n = state.openai.length
  await send('with a key')
  await hears(n + 1)
  check('with a key: it is sent', lastAi().key === CUSTOM_KEY)

  await openSettings()
  await address.fill(`${BASE}/noopts/v1`)
  await address.blur()
  await saveSettings()
  n = state.openai.length
  await send('old server')
  await hears(n + 2)
  check('a server that refuses token counts: asked again without', lastAi().api === 'noopts/v1' && !lastAi().body.stream_options && (await panel.locator('.ai-msg.assistant', { hasText: 'Hello from fake noopts' }).count()) === 1)

  await openSettings()
  await address.fill(`${BASE}/moved/v1`)
  await address.blur()
  await saveSettings()
  n = state.openai.length
  const movedBefore = state.moved
  await send('redirect me')
  check('a redirect is not followed: key and text stay put', (await noticeHas('Could not reach')) && state.moved === movedBefore + 1 && state.openai.length === n)
  await box.fill('')

  await openSettings()
  await address.fill('')
  await address.blur()
  await saveSettings()
  await poll(async () => (await panel.locator('button', { hasText: 'Set up server' }).count()) === 1)
  await panel.locator('button', { hasText: 'Set up server' }).click()
  await address.waitFor()
  await wait()
  check('no address: the panel leads to that field', (await win.evaluate(() => document.activeElement?.getAttribute('name'))) === 'aiBaseUrl')
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
  await wait(800)

  console.log('--- no model chosen')
  const clearModelThenPoint = async (path) => {
    await openSettings()
    await provider('Custom')
    await win.locator('input[name=aiBaseUrl]').fill(BASE + '/custom/v1')
    await win.locator('input[name=aiBaseUrl]').blur()
    await poll(async () => (await options()).includes('local-1'))
    await modelSelect.selectOption({ label: 'Other, type its name…' })
    await win.locator('input[name=aiModelName]').fill('')
    await win.locator('input[name=aiBaseUrl]').fill(BASE + path)
    await win.locator('input[name=aiBaseUrl]').blur()
  }
  await clearModelThenPoint('/one/v1')
  check('a server with one model: it gets chosen, so Save really saves it', await poll(async () => (await modelSelect.inputValue()) === 'only-model'), await modelSelect.inputValue())
  check('…one model reads right', /\b1 model available/.test(await pageText()))
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
  await wait()

  await clearModelThenPoint('/noopts/v1')
  await poll(async () => (await options()).includes('local-1'))
  check('several models: none looks chosen until one is', (await modelSelect.inputValue()) === '' && (await options())[0] === 'Choose a model…', (await options()).join(','))
  await saveSettings()
  check('the panel asks for one', /Custom · choose a model/.test(await win.locator('.ai-picker .ai-model').innerText()))
  const heard = state.openai.length
  await send('with no model')
  check('sending says to pick one', await noticeHas('Pick a model'))
  check('…nothing went out', state.openai.length === heard)
  check('…and the words come back to the box', (await box.inputValue()) === 'with no model', await box.inputValue())

  // How a chat stood before this was fixed: saved with no model, on a server that has just one.
  await win.evaluate((url) => window.api.getSettings().then((s) => window.api.setSettings({ ...s, aiBaseUrl: url, aiModels: { ...s.aiModels, custom: '' } })), BASE + '/one/v1')
  const before = state.openai.length
  await send('one model and none saved')
  await hears(before + 1)
  check('saved with no model on a one-model server: still answers', lastAi()?.api === 'one/v1' && lastAi()?.body.model === 'only-model', JSON.stringify(lastAi()?.body.model))

  console.log('--- changing AI from the chat')
  const picker = win.locator('.ai-picker .ai-model')
  const menu = win.locator('.ai-picker-menu')
  const models = menu.locator('.ai-picker-models button')
  const pickerTab = (name) => menu.locator('.type-picker button', { hasText: name }).click()
  await picker.click()
  check('it opens on the current provider', (await menu.locator('.type-picker button.active').innerText()) === 'Custom')
  check('…with the models of that server', await poll(async () => (await models.count()) > 0))
  await win.screenshot({ path: join(tmpdir(), 'nixi-e2e-ai-picker.png') })
  await win.keyboard.press('Escape')
  check('Esc closes it', (await menu.count()) === 0)
  await picker.click()
  await win.mouse.click(700, 300)
  check('clicking away closes it', (await menu.count()) === 0)

  await picker.click()
  await pickerTab('Gemini')
  await poll(async () => (await models.allInnerTexts()).includes('gemini-new-9'))
  const items = await win.locator('.ai-list > *').count()
  await models.filter({ hasText: 'gemini-new-9' }).click()
  const ask = win.locator('.modal', { hasText: 'Switch to Gemini?' })
  await ask.waitFor()
  check('another provider with a chat open: asks first', /Nothing from it goes to Gemini/.test(await ask.innerText()))
  await ask.locator('button', { hasText: 'Cancel' }).click()
  await wait()
  check('Cancel keeps the chat and the AI', /^Custom/.test(await picker.innerText()) && (await win.locator('.ai-list > *').count()) === items)

  await picker.click()
  await pickerTab('Gemini')
  await poll(async () => (await models.allInnerTexts()).includes('gemini-new-9'))
  await models.filter({ hasText: 'gemini-new-9' }).click()
  await ask.locator('button', { hasText: 'Switch' }).click()
  await wait()
  check('Switch changes the AI', /Gemini · gemini-new-9/.test(await picker.innerText()), await picker.innerText())
  check('…and starts a new chat', (await panel.locator('.ai-notice, .ai-user').count()) === 0)
  const atSwitch = state.openai.length
  await send('hello from the picker')
  await hears(atSwitch + 1)
  check('…and the next message goes there', lastAi().api === 'v1beta/openai' && lastAi().key === GEMINI_KEY && lastAi().body.model === 'gemini-new-9')
  check('…with no word of the old chat', !lastAi().raw.includes('one model and none saved'))
  check('it survives a restart of the panel', (await win.evaluate(() => window.api.getSettings())).aiProvider === 'gemini')

  await picker.click()
  await poll(async () => (await models.count()) > 0)
  await models.filter({ hasText: 'gemini-3.8-flash' }).click()
  await wait()
  check('another model of the same provider: no question', (await ask.count()) === 0 && /gemini-3\.8-flash/.test(await picker.innerText()))
  check('…and the chat stays', (await panel.locator('.ai-list').innerText()).includes('hello from the picker'))

  await win.evaluate(() => window.api.aiSetKey('gemini', null))
  await picker.click()
  await menu.locator('button', { hasText: 'Add API key' }).click()
  await wait()
  check('no key yet: leads to the key field', (await win.evaluate(() => document.activeElement?.getAttribute('name'))) === 'aiKey')
  await win.evaluate((k) => window.api.aiSetKey('gemini', k), GEMINI_KEY)
  await win.locator('.modal-footer button', { hasText: 'Cancel' }).click()
  await wait(800)

  console.log('--- keys')
  const dbFile = readdirSync(userData).find((f) => f.endsWith('.nxdb'))
  const db = readFileSync(join(userData, dbFile), 'latin1')
  check('no key sits in the database in clear', ![CLAUDE_KEY, GEMINI_KEY, CUSTOM_KEY].some((k) => db.includes(k)))
  const has = (p) => win.evaluate((p) => window.api.aiHasKey(p), p)
  check('each provider keeps its own', (await has('anthropic')) && (await has('gemini')) && (await has('custom')))
  await win.evaluate(() => window.api.aiSetKey('gemini', null))
  check('removing one leaves the others', !(await has('gemini')) && (await has('anthropic')))
} catch (err) {
  check('unexpected error', false, err.message)
} finally {
  await app.close().catch(() => {})
  fake.close()
  rmSync(userData, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
}
console.log(failed ? `\n${failed} FAILED` : '\nALL PASS')
process.exit(failed ? 1 : 0)
