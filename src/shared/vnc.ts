// RFB security types noVNC can complete by itself (VeNCrypt is handled by our proxy).
// None, VNC password, RealVNC RA2ne, TightVNC, Apple Remote Desktop, UltraVNC MS-Logon II.
export const NOVNC_SECURITY_TYPES = [1, 2, 6, 16, 30, 113]
export const SEC_VENCRYPT = 19

/** Prefix of failure reasons made up by the proxy: not a rejected password, so don't ask for one again. */
export const VNC_PROXY_ERROR = '[nixi] '
