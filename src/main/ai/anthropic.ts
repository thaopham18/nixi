import Anthropic from '@anthropic-ai/sdk'
import type { AiModelInfo } from '@shared/ai'
import { PROPOSE_COMMAND, type AiProvider, type AiToolResult, type AiTurn, type AiTurnRequest } from './provider'

const API_URL = 'https://api.anthropic.com'
const MAX_TOKENS = 64000
const JSON_RETRIES = 2

// Set explicitly: the SDK would otherwise follow ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN from the
// environment and could hand the key to another host. Tests may only point it at this computer.
function client(apiKey: string): Anthropic {
  const test = process.env.NIXI_AI_BASE_URL
  return new Anthropic({ apiKey, authToken: null, baseURL: test && /^http:\/\/127\.0\.0\.1:\d+$/.test(test) ? test : API_URL })
}

const STOPS: Record<string, AiTurn['stop']> = { tool_use: 'tool', max_tokens: 'cutoff', refusal: 'refusal', pause_turn: 'pause' }

/** The SDK's own error for a tool input that isn't JSON. Asking again is the documented cure. */
function isBadToolJson(err: unknown): boolean {
  return err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && /tool parameter JSON/.test(err.message)
}

async function turn(req: AiTurnRequest): Promise<AiTurn> {
  const api = client(req.apiKey)
  for (let attempt = 0; ; attempt++) {
    const stream = api.beta.messages.stream(
      {
        model: req.model,
        max_tokens: MAX_TOKENS,
        system: req.system,
        // Eager streaming leaves input validation to us: see parseProposal.
        tools: [{ name: PROPOSE_COMMAND.name, description: PROPOSE_COMMAND.description, input_schema: PROPOSE_COMMAND.schema, eager_input_streaming: true }],
        messages: req.history as Anthropic.Beta.Messages.BetaMessageParam[],
        cache_control: { type: 'ephemeral' },
        ...(req.model === 'claude-haiku-5-5' ? {} : { output_config: { effort: 'medium' as const } }),
        // A question about security tools can trip a classifier: let another model answer instead of refusing.
        ...(req.model === 'claude-opus-5-5' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {})
      },
      { signal: req.signal }
    )
    stream.on('text', (delta) => req.onText(delta))
    try {
      const message = await stream.finalMessage()
      const { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } = message.usage
      return {
        // Unchanged, thinking blocks included: the API checks them on the next turn.
        assistant: { role: 'assistant', content: message.content },
        stop: STOPS[message.stop_reason ?? ''] ?? 'end',
        toolCalls: message.content.flatMap((b) => (b.type === 'tool_use' ? [{ id: b.id, input: b.input }] : [])),
        tokens: input_tokens + output_tokens + (cache_read_input_tokens ?? 0) + (cache_creation_input_tokens ?? 0)
      }
    } catch (err) {
      if (!isBadToolJson(err) || attempt >= JSON_RETRIES) throw err
      req.onRestart()
    }
  }
}

function userMessage(text: string | undefined, results: AiToolResult[]): unknown {
  return {
    role: 'user',
    content: [
      // Tool results come first in the message.
      ...results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })),
      ...(text ? [{ type: 'text', text }] : [])
    ]
  }
}

function explain(err: unknown): string | undefined {
  if (err instanceof Anthropic.APIUserAbortError) return undefined
  if (err instanceof Anthropic.AuthenticationError) return 'Anthropic did not accept this API key. Check it in Settings.'
  if (err instanceof Anthropic.PermissionDeniedError) return 'This API key is not allowed to use this model. Pick another one in Settings.'
  if (err instanceof Anthropic.NotFoundError) return 'Anthropic has no such model, or it has been retired. Pick another model in Settings.'
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate limit reached. Wait a moment and send it again.'
  if (err instanceof Anthropic.APIConnectionError) return 'Could not reach Anthropic. Check your network connection.'
  if (err instanceof Anthropic.InternalServerError) return 'Anthropic is having trouble or is overloaded. Try again shortly.'
  // A 400 carries the reason worth reading, such as a credit balance that ran out.
  return err instanceof Error ? err.message : String(err)
}

export const anthropic: AiProvider = {
  userMessage,
  turn,
  explain,
  checkKey: async (apiKey) => {
    await client(apiKey).models.list({ limit: 1 })
  },
  listModels: async (apiKey) => {
    const models: AiModelInfo[] = []
    for await (const m of client(apiKey).models.list({ limit: 100 })) models.push({ id: m.id, label: m.display_name })
    return models
  }
}
