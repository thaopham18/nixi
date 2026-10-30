import { activePane, showMenu, useStore } from '../store'
import { runMacro } from '../terminals'
import { ToolIcon } from './Icons'
import { handleMenu, newSession, openLocal, toggleRecording } from '../actions'

export function Toolbar(): JSX.Element {
  const multiExec = useStore((s) => s.multiExec)
  const recording = useStore((s) => s.recordingMacro)
  const macros = useStore((s) => s.macros)

  const macroMenu = (e: React.MouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const pane = activePane()
    showMenu({ clientX: rect.left, clientY: rect.bottom + 2, preventDefault: () => e.preventDefault() }, [
      ...macros.map((m) => ({
        label: `▶ ${m.name}${m.hotkey ? `   (${m.hotkey})` : ''}`,
        disabled: !pane?.connId,
        onClick: () => pane && void runMacro(m, pane.id)
      })),
      ...(macros.length ? [{ label: '-', onClick: () => {} }] : []),
      { label: recording ? '■ Stop recording' : '● Record macro', onClick: () => void toggleRecording() },
      { label: 'Manage macros…', onClick: () => handleMenu('macros') }
    ])
  }

  return (
    <div className="toolbar">
      <div className="toolbar-drag" />
      <button onClick={() => newSession()} title="New session">
        <ToolIcon name="plus" />
        <span className="label">Session</span>
      </button>
      <button onClick={openLocal} title="Local terminal">
        <ToolIcon name="terminal" />
        <span className="label">Local</span>
      </button>
      <div className="spacer" />
      <button onClick={() => handleMenu('tunnels')} title="SSH tunnels">
        <ToolIcon name="tunnel" />
        <span className="label">Tunnels</span>
      </button>
      <button onClick={macroMenu} className={recording ? 'recording' : ''} title="Macros">
        {recording ? (
          '● REC'
        ) : (
          <>
            <ToolIcon name="bolt" />
            <span className="label">Macros</span>
            <span className="chevron">▾</span>
          </>
        )}
      </button>
      {recording && (
        <button className="recording" onClick={() => void toggleRecording()}>
          ■ Stop
        </button>
      )}
      <button
        className={multiExec ? 'active-toggle' : ''}
        onClick={() => handleMenu('multiExec')}
        title="Send keystrokes to all terminals"
      >
        <ToolIcon name="multi" />
        <span className="label">Multi-exec</span> {multiExec ? 'ON' : 'OFF'}
      </button>
      <button onClick={() => handleMenu('settings')} title="Settings">
        <ToolIcon name="gear" />
      </button>
    </div>
  )
}
