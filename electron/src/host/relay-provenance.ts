// Marks requests that arrived through the loopback relay dispatcher. A relay
// request reaches the remote port from 127.0.0.1, so without this proof Denia's
// local-request gate would treat it as a trusted desktop request and skip the
// device token. The proof is a per-process secret; it is written only by the
// host relay client, stripped before any route sees it, and checked by the
// access gate.

import crypto from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'

export const RELAY_PROOF_HEADER = 'x-denia-relay-proof'

const proof = crypto.randomBytes(32).toString('base64url')
const proofBytes = Buffer.from(proof, 'utf8')
const relayRequests = new WeakSet<IncomingMessage>()

export const relayProofHeaders = (): Record<string, string> => ({
  [RELAY_PROOF_HEADER]: proof,
})

const matches = (value: string | string[] | undefined): boolean => {
  if (typeof value !== 'string') return false
  const bytes = Buffer.from(value, 'utf8')
  return bytes.length === proofBytes.length && crypto.timingSafeEqual(bytes, proofBytes)
}

/** Must be the first request listener: consume the secret before routing. */
export const consumeRelayProof = (req: IncomingMessage): void => {
  const headers: IncomingHttpHeaders = req.headers
  const value = headers[RELAY_PROOF_HEADER]
  if (value === undefined) return
  delete headers[RELAY_PROOF_HEADER]
  if (matches(value)) relayRequests.add(req)
}

export const hasRelayProvenance = (req: IncomingMessage | null | undefined): boolean =>
  req != null && relayRequests.has(req)
