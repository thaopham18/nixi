import type { Session } from '@shared/types'

// Flat 2D icons for the session tree (16 px grid, crisp at 1× and 2×).

export function FolderIcon({ open = false }: { open?: boolean }): JSX.Element {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden>
      {/* back with the tab */}
      <path d="M1.5 4.2c0-.8.6-1.4 1.4-1.4h3.2c.4 0 .7.1 1 .4l1 1h5c.8 0 1.4.6 1.4 1.4v6.9c0 .8-.6 1.4-1.4 1.4H2.9c-.8 0-1.4-.6-1.4-1.4z" fill="#e0a530" />
      {open ? (
        /* front flap tilted forward */
        <path d="M3.6 7h11c.6 0 1 .6.8 1.1l-1.5 4.6c-.2.6-.7.9-1.3.9H2.2c-.6 0-1-.6-.8-1.1l1.4-4.6c.2-.5.4-.9.8-.9z" fill="#f7c64f" />
      ) : (
        <path d="M1.5 6.2c0-.6.5-1.1 1.1-1.1h10.8c.6 0 1.1.5 1.1 1.1v5.7c0 .8-.6 1.4-1.4 1.4H2.9c-.8 0-1.4-.6-1.4-1.4z" fill="#f7c64f" />
      )}
    </svg>
  )
}

/** Plain page with a folded corner, for files in the SFTP list. */
export function FileIcon(): JSX.Element {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden>
      <path d="M3.5 2.4c0-.5.4-.9.9-.9h5.2l3.4 3.4v8.7c0 .5-.4.9-.9.9H4.4c-.5 0-.9-.4-.9-.9z" fill="#c7d2e0" />
      <path d="M9.6 1.5v2.6c0 .5.4.8.8.8H13z" fill="#8fa1b8" />
      <path d="M5.6 8.2h4.8M5.6 10.4h4.8M5.6 12.6h3" stroke="#8fa1b8" strokeWidth="1" strokeLinecap="round" />
    </svg>
  )
}

const tile: Record<Session['type'], string> = { ssh: '#3b82f6', telnet: '#14a39a', rdp: '#6366f1', local: '#64748b' }

/** Rounded colored tile with a white glyph, one color per session type. */
export function SessionIcon({ type }: { type: Session['type'] }): JSX.Element {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden>
      <rect x="1" y="1.5" width="14" height="13" rx="3" fill={tile[type]} />
      {type === 'rdp' ? (
        // a screen on a stand
        <g fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4.3" width="8" height="5.4" rx="0.8" />
          <path d="M8 9.7v1.8M6 11.6h4" />
        </g>
      ) : type === 'telnet' ? (
        // two linked ports
        <g fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round">
          <circle cx="5.2" cy="8" r="1.6" />
          <circle cx="10.8" cy="8" r="1.6" />
          <path d="M6.8 8h2.4" />
        </g>
      ) : (
        // prompt >_
        <g fill="none" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.3 5.3 6.8 8l-2.5 2.7" />
          <path d="M8.6 10.8h3" />
        </g>
      )}
    </svg>
  )
}

export function ClockIcon(): JSX.Element {
  return (
    <svg className="ico" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" strokeWidth="1.4" opacity="0.7" />
      <path d="M8 4.8V8l2.2 1.4" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity="0.7" />
    </svg>
  )
}

export function Caret({ open }: { open: boolean }): JSX.Element {
  return (
    <svg className={`caret-ico ${open ? 'open' : ''}`} viewBox="0 0 10 10" aria-hidden>
      <path d="M3.5 2 6.5 5l-3 3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

type ToolName = 'plus' | 'terminal' | 'tunnel' | 'bolt' | 'multi' | 'gear' | 'up' | 'home' | 'refresh' | 'folderPlus' | 'upload' | 'download' | 'trash' | 'pin' | 'chevLeft' | 'chevRight'

const toolPaths: Record<ToolName, JSX.Element> = {
  up: <path d="M8 13V3.5M3.8 7.7 8 3.5l4.2 4.2" />,
  home: <path d="M2.5 7.6 8 2.8l5.5 4.8M4.2 6.4v6.8h2.8V9.8h2v3.4h2.8V6.4" />,
  refresh: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6" />,
  folderPlus: (
    <>
      <path d="M1.8 4.2c0-.7.5-1.2 1.2-1.2h3l1.3 1.4h5.7c.7 0 1.2.5 1.2 1.2V12c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2z" />
      <path d="M8 6.6v4.4M5.8 8.8h4.4" />
    </>
  ),
  upload: <path d="M8 10.5V2.8M4.8 6 8 2.8 11.2 6M2.8 10.5v2.7h10.4v-2.7" />,
  download: <path d="M8 2.8v7.7M4.8 7.3 8 10.5l3.2-3.2M2.8 10.5v2.7h10.4v-2.7" />,
  chevLeft: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  chevRight: <path d="M6 3.5 10.5 8 6 12.5" />,
  pin: <path d="M6 2.5h4M6.8 2.5v3.6L4.6 8.6h6.8L9.2 6.1V2.5M8 8.6v4.9" />,
  trash: <path d="M2.8 4.3h10.4M6.3 4.3V2.8h3.4v1.5M4.1 4.3l.7 8.9h6.4l.7-8.9M6.8 6.8v4M9.2 6.8v4" />,
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  terminal: (
    <>
      <rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" />
      <path d="m4.8 6.2 2 1.8-2 1.8M8.6 10.2h2.6" />
    </>
  ),
  tunnel: <path d="M2.5 5.5h10m-2.5-2.5 2.5 2.5-2.5 2.5M13.5 10.5h-10m2.5-2.5-2.5 2.5 2.5 2.5" />,
  bolt: <path d="M9 1.8 3.8 9h4l-1 5.2L12.2 7h-4z" />,
  multi: (
    <>
      <rect x="4.8" y="4.8" width="9" height="8.4" rx="1.6" />
      <path d="M11.2 4.8V3.6c0-.7-.6-1.3-1.3-1.3H3.6c-.7 0-1.3.6-1.3 1.3v5.8c0 .7.6 1.3 1.3 1.3h1.2" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2" />
    </>
  )
}

/** Line icons for toolbar buttons; they take the button's text color. */
export function ToolIcon({ name }: { name: keyof typeof toolPaths }): JSX.Element {
  return (
    <svg className="tool-ico" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      {toolPaths[name]}
    </svg>
  )
}

/** Rounded 2D heart for the welcome title. */
export function HeartIcon(): JSX.Element {
  return (
    <svg className="heart" viewBox="0 0 24 24" aria-hidden>
      <defs>
        <linearGradient id="heart-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ff7a93" />
          <stop offset="1" stopColor="#e5405e" />
        </linearGradient>
      </defs>
      <path
        d="M12 20.6c-.3 0-.6-.1-.8-.3C5.9 15.9 2.6 12.9 2.6 8.9 2.6 6 4.8 3.8 7.6 3.8c1.8 0 3.3.9 4.4 2.3 1.1-1.4 2.6-2.3 4.4-2.3 2.8 0 5 2.2 5 5.1 0 4-3.3 7-8.6 11.4-.2.2-.5.3-.8.3z"
        fill="url(#heart-fill)"
      />
      <path d="M7.2 6.6c-1.3.2-2.2 1.2-2.3 2.5" fill="none" stroke="#fff" strokeOpacity="0.55" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
