import { describe, expect, it } from 'vitest'
import { RDCLEANPATH_VERSION, decodePdu, encodePdu, isNegotiationFailure, tpktLength } from '../src/main/rdp/rdcleanpath'

describe('RDCleanPath PDU', () => {
  it('round-trips a request', () => {
    const x224 = Buffer.from('03000013' + '0ee00000000000' + '0100080003000000', 'hex')
    const enc = encodePdu({ version: RDCLEANPATH_VERSION, destination: '10.0.0.5:3389', proxyAuth: 'token', x224 })
    expect(enc[0]).toBe(0x30)
    expect(decodePdu(enc)).toEqual({
      pdu: { version: 3390, destination: '10.0.0.5:3389', proxyAuth: 'token', x224 },
      size: enc.length
    })
  })

  it('round-trips a response with a long certificate chain and an error', () => {
    const cert = Buffer.alloc(1500, 7)
    const enc = encodePdu({ version: RDCLEANPATH_VERSION, serverCertChain: [cert, cert], serverAddr: '10.0.0.5:3389' })
    expect(decodePdu(enc)?.pdu.serverCertChain).toEqual([cert, cert])
    const err = encodePdu({ version: RDCLEANPATH_VERSION, error: { errorCode: 2, httpStatusCode: 502 } })
    expect(decodePdu(err)?.pdu.error).toEqual({ errorCode: 2, httpStatusCode: 502 })
  })

  it('waits for the full PDU', () => {
    const enc = encodePdu({ version: RDCLEANPATH_VERSION, destination: 'host:3389' })
    expect(decodePdu(enc.subarray(0, enc.length - 1))).toBeNull()
  })

  it('reads TPKT lengths and negotiation failures', () => {
    const fail = Buffer.from('03000013' + '0ed00000123400' + '0300080005000000', 'hex')
    expect(tpktLength(fail)).toBe(19)
    expect(tpktLength(fail.subarray(0, 10))).toBeNull()
    expect(isNegotiationFailure(fail)).toBe(true)
  })
})
