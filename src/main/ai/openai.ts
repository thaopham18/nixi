import { chatModelIds, type AiModelInfo } from '@shared/ai'
import { PROPOSE_COMMAND, type AiProvider, type AiToolResult, type AiTurn, type AiTurnRequest } from './provider'

// The chat completions API that OpenAI made and most others copy: Gemini, OpenRouter, Groq, DeepSeek,
// Ollama, LM Studio… Plain fetch, since an SDK for one of them would add nothing for the rest.

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

// Validated by parseProposal instead: strict options are what these servers disagree on most.
const { additionalProperties: _unused, ...PARAMETERS } = PROPOSE_COMMAND.schema
const TOOLS = [{ type: 'function', function: { name: PROPOSE_COMMAND.name, description: PROPOSE_COMMAND.description, parameters: PARAMETERS } }]

const STOPS: Record<string, AiTurn['stop']> = { length: 'cutoff', content_filter: 'refusal', tool_calls: 'tool', function_call: 'tool', stop: 'end' }

function errorText(raw: string): string {
  try {
    const body = JSON.parse(raw)
    const error = Array.isArray(body) ? body[0]?.error : body.error
    const text = typeof error === 'string' ? error : error?.message
    if (typeof text === 'string' && text) return text
  } catch {
    /* not JSON */
  }
  return raw
}

interface ToolCallParts {
  id?: string
  function: { name: string; arguments: string }
  /** whatever else the server put on it. Gemini's thought signature must come back unchanged. */
  extra: Record<string, unknown>
}

class TurnBuilder {
  text = ''
  calls: ToolCallParts[] = []
  finish?: string
  tokens = 0

  add(chunk: { choices?: unknown; usage?: { total_tokens?: unknown }; error?: unknown }, onText: (t: string) => void): void {
    if (chunk.error) throw new HttpError(500, errorText(JSON.stringify({ error: chunk.error })))
    if (typeof chunk.usage?.total_tokens === 'number') this.tokens = chunk.usage.total_tokens
    const choice = (Array.isArray(chunk.choices) ? chunk.choices[0] : undefined) as { delta?: any; message?: any; finish_reason?: unknown } | undefined
    if (!choice) return
    const delta = choice.delta ?? choice.message
    if (typeof delta?.content === 'string' && delta.content) {
      this.text += delta.content
      onText(delta.content)
    }
    if (Array.isArray(delta?.tool_calls)) delta.tool_calls.forEach((part: any, n: number) => this.addCall(part, n))
    if (typeof choice.finish_reason === 'string') this.finish = choice.finish_reason
  }

  private addCall(part: any, position: number): void {
    const index = typeof part?.index === 'number' ? part.index : position
    const call = (this.calls[index] ??= { function: { name: '', arguments: '' }, extra: {} })
    const { index: _index, id, type: _type, function: fn, ...extra } = part ?? {}
    if (typeof id === 'string' && id) call.id = id
    if (typeof fn?.name === 'string') call.function.name += fn.name
    if (typeof fn?.arguments === 'string') call.function.arguments += fn.arguments
    Object.assign(call.extra, extra)
  }

  turn(): AiTurn {
    const seen = new Set<string>()
    const calls = this.calls.filter(Boolean).map((c, n) => {
      // Some servers leave the id empty or repeat it, and every call needs its own answer.
      const id = c.id && !seen.has(c.id) ? c.id : `call_${n}_${seen.size}`
      seen.add(id)
      return { ...c, id }
    })
    const stop = STOPS[this.finish ?? ''] ?? 'end'
    return {
      assistant: {
        role: 'assistant',
        content: this.text || null,
        ...(calls.length ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: c.function, ...c.extra })) } : {})
      },
      // Not every server says tool_calls when it made some, but cut-offs and refusals stay what they are.
      stop: calls.length && stop === 'end' ? 'tool' : stop,
      toolCalls: calls.map((c) => ({ id: c.id, input: parseArguments(c) })),
      tokens: this.tokens
    }
  }
}

/** Anything unusable comes out undefined, and parseProposal tells the model so. */
function parseArguments(call: ToolCallParts): unknown {
  if (call.function.name !== PROPOSE_COMMAND.name) return undefined
  try {
    return JSON.parse(call.function.arguments)
  } catch {
    return undefined
  }
}

async function readEvents(body: ReadableStream<Uint8Array>, builder: TurnBuilder, onText: (t: string) => void): Promise<boolean> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  let done = false
  const line = (raw: string): void => {
    const text = raw.trim()
    if (!text.startsWith('data:')) return
    const data = text.slice(5).trim()
    if (data === '[DONE]') done = true
    else if (data) builder.add(JSON.parse(data), onText)
  }
  for (;;) {
    const { value, done: ended } = await reader.read().catch((err) => {
      if (err?.name === 'AbortError') throw err
      throw new HttpError(502, 'The connection ended before the answer was complete.')
    })
    if (ended) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    lines.forEach(line)
  }
  line(buffer)
  return done
}

export function openAiCompatible(baseUrl: string, name: string): AiProvider {
  const request = async (path: string, apiKey: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(`${baseUrl}/${path}`, {
      ...init,
      // A redirect could carry the key and the terminal text somewhere the user never named.
      redirect: 'error',
      headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), ...(init.body ? { 'content-type': 'application/json' } : {}) }
    })
    if (!res.ok) throw new HttpError(res.status, errorText(await res.text()).replaceAll(apiKey || '\0', '[hidden]').slice(0, 400))
    return res
  }

  const models = async (apiKey: string): Promise<AiModelInfo[]> => {
    const res = await request('models', apiKey)
    const body = (await res.json()) as { data?: { id?: unknown }[] }
    return chatModelIds((body.data ?? []).flatMap((m) => (typeof m.id === 'string' ? [m.id] : []))).map((id) => ({ id }))
  }

  const post = (req: AiTurnRequest, usage: boolean): Promise<Response> =>
    request('chat/completions', req.apiKey, {
      method: 'POST',
      signal: req.signal,
      body: JSON.stringify({
        model: req.model,
        stream: true,
        ...(usage ? { stream_options: { include_usage: true } } : {}),
        messages: [{ role: 'system', content: req.system }, ...req.history.flat()],
        tools: TOOLS
      })
    })

  return {
    userMessage(text: string | undefined, results: AiToolResult[]) {
      // One message for each result, so this history item is a list: turn() flattens it.
      return [...results.map((r) => ({ role: 'tool', tool_call_id: r.id, content: r.text })), ...(text ? [{ role: 'user', content: text }] : [])]
    },

    async turn(req) {
      const res = await post(req, true).catch((err) => {
        // Older servers refuse the option that asks for token counts: it isn't worth failing over.
        if (err instanceof HttpError && err.status === 400 && /stream_options/.test(err.message)) return post(req, false)
        throw err
      })
      const builder = new TurnBuilder()
      if (!res.body) throw new HttpError(502, 'The server sent an empty answer.')
      if (/json/.test(res.headers.get('content-type') ?? '')) {
        builder.add((await res.json()) as object, req.onText)
      } else {
        const done = await readEvents(res.body, builder, req.onText)
        // A dropped connection can leave half a command: never treat that as an answer.
        if (!done && !builder.finish) throw new HttpError(502, 'The connection ended before the answer was complete.')
      }
      return builder.turn()
    },

    async checkKey(apiKey) {
      await models(apiKey)
    },

    listModels: models,

    explain(err) {
      if ((err as { name?: string } | undefined)?.name === 'AbortError') return undefined
      if (err instanceof HttpError) {
        if (err.status === 401 || err.status === 403) return `${name} did not accept this API key (${err.message}). Check it in Settings.`
        if (err.status === 404) return `${name} has no such model, or no API at this address (${err.message}). Pick another model in Settings.`
        if (err.status === 429) return `${name} rate limit reached. Wait a moment and send it again.`
        if (err.status >= 500) return `${name} is having trouble: ${err.message}`
        return err.message
      }
      if (err instanceof SyntaxError) return `${name} sent an answer Nixi can't read.`
      return `Could not reach ${name}. Check your network connection and the address.`
    }
  }
}
