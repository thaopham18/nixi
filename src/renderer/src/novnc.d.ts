// The parts of noVNC's RFB class that Nixi uses (the package ships no types).
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    static messages: { fbUpdateRequest(sock: unknown, incremental: boolean, x: number, y: number, w: number, h: number): void }
    constructor(target: HTMLElement, url: string, options?: { shared?: boolean; credentials?: VncCredentials })
    viewOnly: boolean
    scaleViewport: boolean
    resizeSession: boolean
    clipViewport: boolean
    background: string
    qualityLevel: number
    compressionLevel: number
    showDotCursor: boolean
    disconnect(): void
    focus(): void
    sendCredentials(creds: VncCredentials): void
    sendCtrlAltDel(): void
    clipboardPasteFrom(text: string): void
  }
  export interface VncCredentials {
    username?: string
    password?: string
    target?: string
  }
}
