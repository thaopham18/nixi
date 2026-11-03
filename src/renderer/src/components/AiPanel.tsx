import { aiModelOf, aiProviderInfo } from '@shared/ai'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment } from '@shared/ai'
import { api } from '../api'
import { activePaneOf, useStore, openSettings } from '../store'
import { answerProposal, clearChat, EMPTY_CHAT, GENERAL_CHAT, outputOf, runProposal, sendAi, setAutoRun, stopAi, updateChat, type AiItem } from '../ai'
import { attachableText, focusTerminal, runBlock } from '../terminals'

const REFRESH_MS = 1000
const DONE_NOTE: Partial<Record<Extract<AiItem, { kind: 'proposal' }>['state'], string>> = {
  sent: 'Ran. Output sent.',
  kept: 'Ran. Output not sent.',
  skipped: 'Skipped.',
  dropped: 'Not answered.'
}

/** Text as it would be sent, kept current; `raw` is what produced it, so sending never differs from what was shown. */
function usePreview<T extends { raw: string }>(read: () => T | undefined): (T & Attachment) | undefined {
  const [shown, setShown] = useState<(T & Attachment) | undefined>()
  const latest = useRef(read)
  latest.current = read
  useEffect(() => {
    let last: string | undefined
    let alive = true
    const refresh = (): void => {
      const now = latest.current()
      if (now?.raw === last) return
      last = now?.raw
      if (!now) return setShown(undefined)
      void api.aiPreview(now.raw).then((p) => {
        if (alive && last === now.raw) setShown({ ...now, ...p })
      })
    }
    refresh()
    const timer = setInterval(refresh, REFRESH_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])
  return shown
}

/** Plain text with fenced code blocks; an open fence while streaming runs to the end. Never parsed as HTML. */
function Rich({ text }: { text: string }): JSX.Element {
  const parts = text.split(/```[^\n]*\n?/)
  return (
    <>
      {parts.map((part, i) =>
        i % 2 ? (
          <pre key={i} className="ai-code">
            {part.replace(/\n$/, '')}
          </pre>
        ) : (
          part.trim() && <p key={i}>{part.trim()}</p>
        )
      )}
    </>
  )
}

function DroppedNote({ dropped }: { dropped: number }): JSX.Element | null {
  return dropped ? <div className="muted small">The first {dropped} lines are left out.</div> : null
}

function Proposal({ chatId, item }: { chatId: string; item: Extract<AiItem, { kind: 'proposal' }> }): JSX.Element {
  const [blocked, setBlocked] = useState<string | undefined>()
  const pending = item.state === 'pending'
  const ran = item.state === 'ran'
  useEffect(() => {
    if (!pending) return
    const check = (): void => setBlocked(runBlock(chatId))
    check()
    const timer = setInterval(check, REFRESH_MS)
    return () => clearInterval(timer)
  }, [pending, chatId])
  return (
    <div className="ai-proposal" data-state={item.state}>
      <pre className="ai-code">{item.command}</pre>
      <p className="muted small">{item.reason}</p>
      {pending && (
        <>
          {blocked && <p className="error-line small">{blocked}</p>}
          {!blocked && item.asks && <p className="warn-line small">{item.asks}</p>}
          <div className="row end">
            <button onClick={() => answerProposal(chatId, item.id, { kind: 'skipped' })}>Skip</button>
            <button className="primary" disabled={!!blocked} onClick={() => void runProposal(chatId, item.id, item.command)}>
              Run
            </button>
          </div>
        </>
      )}
      {ran && <OutputReview chatId={chatId} id={item.id} />}
      {item.state === 'running' && <p className={item.holding ? 'warn-line small' : 'muted small'}>{item.holding ? 'Waiting for your answer in the terminal…' : 'Running…'}</p>}
      {!pending && !ran && item.state !== 'running' && <p className="muted small">{DONE_NOTE[item.state]}</p>}
      {item.output !== undefined && (
        <details>
          <summary className="muted small">Output sent</summary>
          <pre className="ai-attach-text">{item.output}</pre>
        </details>
      )}
    </div>
  )
}

function OutputReview({ chatId, id }: { chatId: string; id: string }): JSX.Element {
  const output = usePreview(() => {
    const raw = outputOf(id)
    return raw === undefined ? undefined : { raw }
  })
  return (
    <div className="ai-review">
      <div className="muted small">Output to send. Send it once the command has finished.</div>
      <pre className="ai-attach-text">{output?.text}</pre>
      {output && <DroppedNote dropped={output.dropped} />}
      <div className="row end">
        <button onClick={() => answerProposal(chatId, id, { kind: 'kept' })}>Don't send</button>
        <button className="primary" disabled={!output} onClick={() => output && answerProposal(chatId, id, { kind: 'output', raw: output.raw })}>
          Send to AI
        </button>
      </div>
    </div>
  )
}

function Message({ chatId, item }: { chatId: string; item: AiItem }): JSX.Element {
  if (item.kind === 'proposal') return <Proposal chatId={chatId} item={item} />
  if (item.kind === 'notice')
    return (
      <div className={item.error ? 'ai-notice error-line small' : 'ai-notice muted small'}>
        {item.text}
        {item.error && item.text.includes('in Settings') && (
          <>
            {' '}
            <button className="link" onClick={() => openSettings('ai', /model/i.test(item.text) ? 'aiModel' : /address/i.test(item.text) ? 'aiBaseUrl' : 'aiKey')}>
              Open Settings
            </button>
          </>
        )}
      </div>
    )
  if (item.kind === 'assistant')
    return (
      <div className="ai-msg assistant">
        <Rich text={item.text} />
        {item.stopped && <div className="muted small">Stopped.</div>}
      </div>
    )
  return (
    <div className={`ai-msg user ${item.undelivered ? 'undelivered' : ''}`}>
      <p>{item.text}</p>
      {item.attachment && (
        <details>
          <summary className="muted small">Attached terminal text</summary>
          <pre className="ai-attach-text">{item.attachment}</pre>
        </details>
      )}
      {item.undelivered && <div className="muted small">Not delivered.</div>}
    </div>
  )
}

function Composer({ chatId, paneId, busy, draft }: { chatId: string; paneId?: string; busy: boolean; draft: string }): JSX.Element {
  const [attach, setAttach] = useState(true)
  const [showAttachment, setShowAttachment] = useState(false)
  const preview = usePreview(() => (paneId ? attachableText(paneId) : undefined))
  // The pane may change under the hook; a preview only counts for the pane it was read from.
  const current = preview && paneId && preview.paneId === paneId ? preview : undefined
  const attached = attach && current?.text ? current : undefined
  const canSend = draft.trim().length > 0 && !busy
  const auto = useStore((s) => s.settings?.aiAutoRun === true)

  const send = (): void => {
    if (!canSend) return
    void sendAi(chatId, draft.trim(), attached && { raw: attached.raw, source: attached.source, shown: attached.text })
  }

  return (
    <div className="ai-composer">
      {current?.text && (
        <div className="ai-attach">
          <div className="ai-attach-row">
            <label className="check">
              <input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach {current.source === 'selection' ? 'selection' : 'screen'}
            </label>
            <button className="link" onClick={() => setShowAttachment(!showAttachment)}>
              {showAttachment ? 'Hide' : 'Preview'}
            </button>
          </div>
          {showAttachment && (
            <>
              <pre className="ai-attach-text">{current.text}</pre>
              <DroppedNote dropped={current.dropped} />
            </>
          )}
        </div>
      )}
      <textarea
        name="aiMessage"
        rows={3}
        placeholder="Ask about this terminal…"
        value={draft}
        onChange={(e) => updateChat(chatId, () => ({ draft: e.target.value }))}
        onKeyDown={(e) => {
          // isComposing: Enter that finishes a Vietnamese or other IME word is not a send.
          if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return
          e.preventDefault()
          send()
        }}
      />
      <div className="ai-send-row">
        <div className={`type-picker ai-mode ${auto ? 'auto' : ''}`} title="Who decides when a command runs">
          <button className={auto ? '' : 'active'} onClick={() => void setAutoRun(false)}>
            Ask me
          </button>
          <button className={auto ? 'active' : ''} onClick={() => !auto && void setAutoRun(true)}>
            Auto
          </button>
        </div>
        {busy ? (
          <button onClick={() => stopAi(chatId)}>Stop</button>
        ) : (
          <button className="primary" disabled={!canSend} onClick={send}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}

export function AiPanel(): JSX.Element {
  const paneId = useStore((s) => activePaneOf(s)?.id)
  const chatId = paneId ?? GENERAL_CHAT
  const chat = useStore((s) => s.aiChats[chatId]) ?? EMPTY_CHAT
  const modal = useStore((s) => s.modal)
  const settingsAuto = useStore((s) => s.settings?.aiAutoRun === true)
  const aiSettings = useStore((s) => s.settings)
  const provider = aiProviderInfo(aiSettings?.aiProvider)
  const model = aiModelOf(aiSettings)
  const [hasKey, setHasKey] = useState<boolean | undefined>()
  const list = useRef<HTMLDivElement>(null)

  // The key is set in Settings, so look again when a dialog closes.
  useEffect(() => void api.aiIsReady().then(setHasKey), [modal])

  // Follow the newest item, unless the user scrolled up to read. Decided before the new item lands:
  // a card with Run on it can be taller than any "near the bottom" margin.
  const following = useRef(true)
  useLayoutEffect(() => {
    if (following.current && list.current) list.current.scrollTop = list.current.scrollHeight
  }, [chat.items, chat.busy])
  useLayoutEffect(() => {
    following.current = true
    if (list.current) list.current.scrollTop = list.current.scrollHeight
  }, [chatId, hasKey])
  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    following.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (hasKey === undefined) return <div className="ai-panel" />
  if (!hasKey)
    return (
      <div className="ai-panel">
        <div className="empty">
          <p>Ask AI about what is happening in your terminal, using your own {provider.id === 'custom' ? 'server' : `${provider.label} API key`}.</p>
          <button className="primary" onClick={() => (provider.id === 'custom' ? openSettings('ai', 'aiBaseUrl') : openSettings('ai', 'aiKey'))}>
            {provider.id === 'custom' ? 'Set up server' : 'Add API key'}
          </button>
        </div>
      </div>
    )

  const thinking = chat.busy && chat.items[chat.items.length - 1]?.kind !== 'assistant'
  return (
    <div className="ai-panel">
      <div className="ai-list" ref={list} onScroll={onScroll}>
        {chat.items.length === 0 && (
          <div className="empty">
            <p>Nothing leaves this computer until you send a message, and then it goes to {provider.id === 'custom' ? 'your server' : provider.label} ({model}). {settingsAuto ? 'In Auto, AI runs commands that only look and reads the output. Anything else waits for Run.' : 'Commands run only when you click Run.'}</p>
          </div>
        )}
        {chat.items.map((item, i) => (
          <Message key={item.kind === 'proposal' ? item.id : i} chatId={chatId} item={item} />
        ))}
        {thinking && <div className="ai-notice muted small">Thinking…</div>}
      </div>
      {(chat.items.length > 0 || chat.tokens > 0) && (
        <div className="ai-meta muted small">
          <span className="ai-model" title={model}>
            {model}
            {chat.tokens ? ` · ${chat.tokens.toLocaleString('en-US')} tokens` : ''}
          </span>
          <button
            className="link"
            onClick={() => {
              clearChat(chatId)
              if (paneId) focusTerminal(paneId)
            }}
          >
            Clear
          </button>
        </div>
      )}
      {/* Remounted per pane: the preview and the Attach choice belong to one terminal. */}
      <Composer key={chatId} chatId={chatId} paneId={paneId} busy={chat.busy || chat.running} draft={chat.draft} />
    </div>
  )
}
