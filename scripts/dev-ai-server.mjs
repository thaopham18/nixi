// A stand-in for the Anthropic API, so the assistant can be tested for free and without a key.
// Replies depend on the newest user text, and every request is recorded for the test to inspect:
//   TOOL:<command>   proposes the command        CUTTOOL     tool call cut off by max_tokens
//   BADTOOL          invalid tool input once     CUTTEXT     text cut off by max_tokens
//   REFUSE           refusal after partial text  ERR401/429  API errors
//   DROP             connection lost mid-answer  SLOW        streams slowly, for Stop
//   TWOTOOLS:<a> THEN <b>   proposes both in one answer
// A tool result gets "Thanks, got it." unless it holds one of the words above.
// The same words work on the OpenAI-style API under /v1beta/openai (as Gemini) and /custom/v1, plus
// BADJSON (tool input that isn't JSON) and ERR404; /noopts/v1 refuses stream_options, /moved/v1 redirects.
//   node scripts/dev-ai-server.mjs [--port 8765]
import { createServer } from 'http'
import { pathToFileURL } from 'url'

const THINKING = { type: 'thinking', thinking: '', signature: 'sig-kept-as-is' }

function latestUserText(messages) {
  const last = messages[messages.length - 1]
  if (typeof last.content === 'string') return last.content
  return last.content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? String(b.content) : '')).join('\n')
}

const OPENAI_PATH = /^\/(v1beta\/openai|custom\/v1|one\/v1|noopts\/v1|moved\/v1)\/(models|chat\/completions)$/
const SIGNATURE = 'gemini-signature-kept-as-is'

function openAiLatest(messages) {
  const last = messages[messages.length - 1]
  return last.role === 'tool' ? `tool_result ${messages.filter((m) => m.role === 'tool').pop().content}` : String(last.content)
}

function openAi(req, res, state, api, route) {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const key = req.headers.authorization?.replace(/^Bearer /, '')
  const fail = (status, message) => json(status, { error: { message, type: 'error' } })
  if (api === 'moved/v1') {
    state.moved++
    res.writeHead(302, { location: '/custom/v1/' + route })
    return res.end()
  }
  if (key === 'bad-key') return fail(401, 'API key not valid. Please pass a valid API key.')
  if (route === 'models') {
    state.modelChecks.push({ key, url: req.url })
    if (state.failModels) return fail(500, 'list is down')
    const data = api === 'one/v1' ? ['only-model'] : api === 'v1beta/openai' ? ['models/gemini-new-9', 'models/gemini-3.8-flash', 'models/gemini-new-9-tts', 'models/text-embedding-9'] : ['local-1', 'local-2']
    return json(200, { object: 'list', data: data.map((id) => ({ id, object: 'model' })) })
  }
  let raw = ''
  req.on('data', (d) => (raw += d))
  req.on('end', async () => {
    const body = JSON.parse(raw)
    state.openai.push({ api, key, body, raw })
    const text = openAiLatest(body.messages)
    if (api === 'noopts/v1' && body.stream_options) return fail(400, 'Unrecognized request argument: stream_options')
    if (text.includes('ERR401')) return fail(401, `invalid key ${key}`)
    if (text.includes('ERR404')) return fail(404, 'model not found')
    if (text.includes('ERR429')) return fail(429, 'slow down')
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    const end = (reason) => {
      send({}, reason)
      if (body.stream_options) res.write(`data: ${JSON.stringify({ choices: [], usage: { total_tokens: 77 } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    }
    // Split the way real servers split it, with the signature Gemini expects back.
    const tool = (args) => {
      const id = `call_${++state.toolCount}`
      const cut = Math.floor(args.length / 2)
      const extra = api === 'v1beta/openai' ? { extra_content: { google: { thought_signature: SIGNATURE } } } : {}
      send({ role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: 'propose_command', arguments: args.slice(0, cut) }, ...extra }] })
      send({ tool_calls: [{ index: 0, function: { arguments: args.slice(cut) } }] })
    }
    if (text.includes('DROP')) {
      send({ content: 'partial answer' })
      return setTimeout(() => res.destroy(), 50)
    }
    if (text.includes('REFUSE')) {
      send({ content: 'partial answer that must go away' })
      return end('content_filter')
    }
    if (text.includes('CUTTOOL')) {
      tool('{"command":"rm -rf /","rea')
      return end('length')
    }
    if (text.includes('Invalid input')) {
      send({ content: 'Sorry, that command was invalid.' })
      return end('stop')
    }
    if (text.includes('BADJSON')) {
      tool('{"command":"ls')
      return end('tool_calls')
    }
    if (text.includes('SLOW')) {
      for (let i = 0; i < 100 && !res.destroyed; i++) {
        send({ content: `slow${i} ` })
        await new Promise((r) => setTimeout(r, 100))
      }
      return end('stop')
    }
    const proposal = /TOOL:(.+?)(?:\n|$|<)/.exec(text)
    if (proposal && !text.startsWith('tool_result')) {
      send({ content: 'Here is a command.' })
      tool(JSON.stringify({ command: proposal[1].trim(), reason: 'Because the test asked.' }))
      return end(api === 'custom/v1' ? 'stop' : 'tool_calls') // some servers never say tool_calls
    }
    send({ content: text.startsWith('tool_result') ? 'Thanks, got it.' : `Hello from fake ${api}.` })
    end('stop')
  })
}

export function startFakeAi(port = 0) {
  const state = { requests: [], openai: [], modelChecks: [], toolCount: 0, moved: 0, failModels: false }
  const server = createServer((req, res) => {
    const openAiRoute = OPENAI_PATH.exec(req.url)
    if (openAiRoute) return openAi(req, res, state, openAiRoute[1], openAiRoute[2])
    const json = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const apiError = (status, type, message) => json(status, { type: 'error', error: { type, message } })
    // SDK 1.x sends an API key as a bearer token; the API takes either header.
    const key = req.headers['x-api-key'] ?? req.headers.authorization?.replace(/^Bearer /, '')
    if (key === 'bad-key') return apiError(401, 'authentication_error', 'invalid x-api-key')

    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      state.modelChecks.push({ key, url: req.url })
      if (state.failModels) return apiError(500, 'api_error', 'list is down')
      const data = [
        { id: 'claude-new-9', type: 'model', display_name: 'Claude New 9', created_at: '2027-01-01T00:00:00Z' },
        { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z' }
      ]
      return json(200, { data, has_more: false, first_id: data[0].id, last_id: data[1].id })
    }
    if (req.method !== 'POST' || !req.url.startsWith('/v1/messages')) return apiError(404, 'not_found_error', 'no such route')

    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', async () => {
      const body = JSON.parse(raw)
      state.requests.push({ key, beta: req.headers['anthropic-beta'], body, raw })
      if (body.model === 'claude-gone') return apiError(404, 'not_found_error', 'model: claude-gone')
      const text = latestUserText(body.messages)
      if (text.includes('ERR401')) return apiError(401, 'authentication_error', 'invalid x-api-key')
      if (text.includes('ERR429')) return apiError(429, 'rate_limit_error', 'slow down')

      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      send({
        type: 'message_start',
        message: { id: `msg_${state.requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } }
      })
      let index = 0
      const thinking = () => {
        send({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '', signature: '' } })
        send({ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: THINKING.signature } })
        send({ type: 'content_block_stop', index: index++ })
      }
      const say = (t) => {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: t } })
        send({ type: 'content_block_stop', index: index++ })
      }
      const tool = (input) => {
        const id = `toolu_${++state.toolCount}`
        send({ type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'propose_command', input: {} } })
        send({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } })
        send({ type: 'content_block_stop', index: index++ })
      }
      const finish = (stop_reason) => {
        send({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } })
        send({ type: 'message_stop' })
        res.end()
      }
      thinking()
      const proposal = /TOOL:(.+?)(?:\n|$|<)/.exec(text)
      if (text.includes('DROP')) {
        say('partial answer')
        return setTimeout(() => res.destroy(), 50)
      }
      if (text.includes('REFUSE')) {
        say('partial answer that must go away')
        return finish('refusal')
      }
      if (text.includes('CUTTOOL')) {
        tool({ command: 'rm -rf /' })
        return finish('max_tokens')
      }
      if (text.includes('CUTTEXT')) {
        say('A long answer that')
        return finish('max_tokens')
      }
      if (text.includes('BADTOOL')) {
        tool({ command: 'ls\nrm -rf /', reason: 'hides a second line' })
        return finish('tool_use')
      }
      if (text.includes('Invalid input')) {
        say('Sorry, that command was invalid.')
        return finish('end_turn')
      }
      if (text.includes('SLOW')) {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        for (let i = 0; i < 100 && !res.destroyed; i++) {
          send({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: `slow${i} ` } })
          await new Promise((r) => setTimeout(r, 100))
        }
        send({ type: 'content_block_stop', index: index++ })
        return finish('end_turn')
      }
      const pair = /TWOTOOLS:(.+?) THEN (.+?)(?:\n|$|<)/.exec(text)
      if (pair) {
        tool({ command: pair[1], reason: 'first of two' })
        tool({ command: pair[2], reason: 'second of two' })
        return finish('tool_use')
      }
      if (proposal) {
        say('Here is a command.')
        tool({ command: proposal[1].trim(), reason: 'Because the test asked.' })
        return finish('tool_use')
      }
      say(text.includes('tool_result') || /chose not|user ran/i.test(text) ? 'Thanks, got it.' : 'Hello from fake Claude.\n```\nsome code\n```\nDone.')
      finish('end_turn')
    })
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => server.close() })))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const i = process.argv.indexOf('--port')
  const { port } = await startFakeAi(i > 0 ? Number(process.argv[i + 1]) : 8765)
  console.log(`Fake Anthropic API on http://127.0.0.1:${port} (set NIXI_AI_BASE_URL to it)`)
}
