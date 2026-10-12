/**
 * Native iroh transport for remote connections.
 *
 * A saved connection whose url is `iroh://<ticket>` never reaches the network
 * as HTTP. Instead the main process binds an iroh endpoint, dials the ticket,
 * and exposes a loopback http://127.0.0.1:<port> whose every TCP connection is
 * piped byte-for-byte over one iroh bidi stream (ALPN 'hermes-http/0') to the
 * remote bridge in front of the gateway. Downstream consumers (fetch, WS,
 * token adoption, revalidation) see a plain remote descriptor — only the
 * transport underneath differs.
 *
 * Wire format parity with tools/iroh/iroh_bridge_{server,client}.py: one bidi
 * stream per TCP connection, raw HTTP/WS bytes both directions, stream finish
 * on socket end.
 */
import { createRequire as nodeCreateRequire } from 'node:module'
import net from 'node:net'

import type * as IrohNative from '@number0/iroh'
import type { BiStream, Connection, Endpoint as IrohEndpoint } from '@number0/iroh'

export const IROH_SCHEME = 'iroh://'

export const IROH_ALPN = Array.from(new TextEncoder().encode('hermes-http/0'))

// The native binding loads lazily so pure ticket logic stays unit-testable
// without touching the platform binary (repo convention: pure-logic tests).
// Aliased import + unique require identifier mirror product-identity.ts — the
// main bundle hoists every module into one scope, and shadowing the plain
// `require`/`createRequire` names collides at bundle time. `IrohNative` is a
// compile-time-only namespace type (erased), so the binary stays lazy.
const irohRequire = nodeCreateRequire(import.meta.url)

let irohBinding: null | typeof IrohNative = null

function binding(): typeof IrohNative {
  if (!irohBinding) {
    irohBinding = irohRequire('@number0/iroh') as typeof IrohNative
  }

  return irohBinding
}

export function isIrohUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase().startsWith(IROH_SCHEME)
}

/** Extract the base32 ticket from a saved url or pasted ticket string. */
export function parseIrohTicket(value: unknown): string {
  // JS trim() leaves zero-width chars (BOM, ZWSP, word-joiner) in place —
  // strip them from the edges FIRST so scheme detection below can't be
  // defeated by a ZWSP in front of "iroh://" (which would otherwise fold the
  // scheme letters — valid base32 — into the ticket silently).
  const raw = String(value ?? '').replace(/^[\s\u200b-\u200d\u2060\ufeff]+|[\s\u200b-\u200d\u2060\ufeff]+$/gi, '')

  const ticket = raw.toLowerCase().startsWith(IROH_SCHEME) ? raw.slice(IROH_SCHEME.length) : raw

  // Closed-set sanitize: valid tickets contain ONLY RFC4648 base32 lowercase
  // ([a-z2-7]), so stripping everything else is lossless for real tickets and
  // immune to paste noise (zero-width spaces, soft breaks, trailing colons,
  // smart-quote bytes) that macOS/clipboard paths inject into long strings.
  const clean = ticket.replace(/[^a-z2-7]/g, '')

  if (!clean) {
    throw new Error('iroh connections need a ticket (the "endpoint…" string from the remote box).')
  }

  // Fail fast on garbage: the binding parses strictly and a malformed ticket
  // should surface at save time, not as a dial timeout later. The binding's
  // own message is appended verbatim — a missing platform binary
  // ("...not installed on this platform") looks identical to a bad ticket
  // from the outside and must be distinguishable in the error toast.
  try {
    binding().EndpointTicket.fromString(clean)
  } catch (err: any) {
    const reason = String(err?.message ?? err).replace(/^Error:\s*/i, '')

    throw new Error(`Not a valid iroh ticket: "${clean.slice(0, 24)}…" (${reason})`)
  }

  return clean
}

/** Canonical saved form for a remote connection backed by iroh. */
export function normalizeIrohUrl(value: unknown): string {
  return `${IROH_SCHEME}${parseIrohTicket(value)}`
}

export interface IrohTunnel {
  connectionId: string
  ticket: string
  baseUrl: string
  port: number
  /** Loop until the endpoint is online (relay registration can take a beat). */
  ready: Promise<void>
  teardown: () => Promise<void>
}

export interface TunnelHandle {
  endpoint: IrohEndpoint
  server: net.Server
  tunnel: IrohTunnel
}

/**
 * Pipe one accepted TCP socket over a fresh bidi stream of the (shared,
 * persistent) iroh connection. Byte-transparent in both directions; either
 * half ending finishes the other.
 */
async function pipeSocketOverStream(socket: net.Socket, openStream: () => Promise<BiStream>): Promise<void> {
  const stream = await openStream()

  socket.on('data', (buf: Buffer) => {
    stream.send.writeAll(Array.from(buf)).catch(() => socket.destroy())
  })

  socket.on('end', () => {
    stream.send.finish().catch(() => {})
  })

  socket.on('error', () => {
    try {
      stream.send.reset(0n)
    } catch {
      /* stream already gone */
    }
  })

  for (;;) {
    const chunk = await stream.recv.read(65536)

    if (!chunk || chunk.length === 0) {
      break
    }

    if (!socket.write(Buffer.from(chunk))) {
      await new Promise<void>(resolve => socket.once('drain', () => resolve()))
    }
  }

  socket.end()
}

/**
 * Ensure a live loopback tunnel for `connectionId` (re-dials the ticket when
 * the endpoint or connection has died). `pickPort` receives the ticket and
 * returns loopback port CANDIDATES (first free wins); injected so tests run
 * without binding sockets.
 */
export async function ensureIrohTunnel(
  connectionId: string,
  url: string,
  deps: {
    bindEndpoint: () => Promise<IrohEndpoint>
    createServer: (onConnection: (socket: net.Socket) => void) => net.Server
    dial: (endpoint: IrohEndpoint, ticket: string) => Promise<Connection>
    log: (msg: string) => void
    pickPort: (seed: string) => Promise<number[]>
    tunnels: Map<string, TunnelHandle>
  }
): Promise<IrohTunnel> {
  const ticket = parseIrohTicket(url)
  const existing = deps.tunnels.get(connectionId)

  if (existing && !existing.server.listening) {
    await existing.tunnel.teardown().catch(() => {})
    deps.tunnels.delete(connectionId)
  } else if (existing && existing.tunnel.ticket === ticket) {
    return existing.tunnel
  } else if (existing) {
    await existing.tunnel.teardown().catch(() => {})
    deps.tunnels.delete(connectionId)
  }

  const endpoint = await deps.bindEndpoint()
  let conn: null | Connection = null

  let resolvingReady: () => void = () => {}

  const ready = new Promise<void>(resolve => {
    resolvingReady = resolve
  })

  const dialOnce = async (): Promise<Connection> => {
    if (conn && !conn.closeReason()) {
      return conn
    }

    deps.log(`[iroh] dialing ${ticket.slice(0, 12)}…`)
    conn = await deps.dial(endpoint, ticket)
    deps.log(`[iroh] connected to ${conn.remoteId().fmtShort()}`)

    return conn
  }

  const handleConnection = (socket: net.Socket): void => {
    socket.on('error', () => {})

    dialOnce().then(conn =>
      pipeSocketOverStream(socket, () => conn.openBi()).catch(err => {
        deps.log(`[iroh] pipe failed: ${String(err?.message ?? err)}`)
        socket.destroy()
      })
    ).catch(err => {
      deps.log(`[iroh] dial failed: ${String(err?.message ?? err)}`)
      conn = null
      socket.destroy()
    })
  }

  // Bind the first free candidate port. EADDRINUSE walks forward (the
  // deterministic scheme can collide with a local service); any other listen
  // error is fatal for this attempt.
  const candidates = await deps.pickPort(ticket)
  let port = 0
  let server: null | net.Server = null

  for (const candidate of candidates) {
    const probe = deps.createServer(handleConnection)

    const bound = await new Promise<boolean>((resolve, reject) => {
      const onError = (err: Error): void => {
        if ((err as { code?: string }).code === 'EADDRINUSE') {
          resolve(false)
        } else {
          reject(err)
        }
      }

      probe.once('error', onError)
      probe.listen(candidate, '127.0.0.1', () => {
        probe.removeListener('error', onError)
        resolve(true)
      })
    })

    if (bound) {
      server = probe
      port = candidate

      break
    }

    deps.log(`[iroh] loopback port ${candidate} busy, trying next`)
  }

  if (!server) {
    await endpoint.close().catch(() => {})
    throw new Error('[iroh] no free loopback port for tunnel')
  }

  const tunnel: IrohTunnel = {
    connectionId,
    ticket,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    ready,
    teardown: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      conn?.close(0n, [])
      await endpoint.close()
    }
  }

  deps.tunnels.set(connectionId, { endpoint, server, tunnel })
  resolvingReady()

  return tunnel
}

/**
 * Process-level tunnel manager used by main.ts: tickets are stable pairing
 * artifacts, so tunnels are keyed by ticket. One manager, many tickets.
 *
 * Cookie-backed sessions (dashboard basic auth) are scoped to the exact
 * loopback origin, so ports must be STABLE across app restarts — an
 * ephemeral pick would silently log the user out every launch. Candidates
 * derive from the ticket and walk forward on collision.
 */
export const LOOPBACK_PORT_BASE = 19100
export const LOOPBACK_PORT_SPAN = 400
export const LOOPBACK_PORT_TRIES = 20

export function deterministicLoopbackPorts(seed: string): number[] {
  let h = 0

  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) | 0
  }

  const start = LOOPBACK_PORT_BASE + Math.abs(h) % LOOPBACK_PORT_SPAN

  return Array.from({ length: LOOPBACK_PORT_TRIES }, (_, i) => start + i)
}

export function createIrohTunnelManager(
  log: (msg: string) => void = () => {},
  pickPort: (seed: string) => Promise<number[]> = async seed => deterministicLoopbackPorts(seed)
) {
  const tunnels = new Map<string, TunnelHandle>()

  return {
    /** Resolve an iroh:// url (or pasted ticket) to a live loopback baseUrl. */
    async ensure(url: string): Promise<IrohTunnel> {
      const ticket = parseIrohTicket(url)

      return ensureIrohTunnel(ticket, ticket, {
        tunnels,
        pickPort,
        log,
        bindEndpoint: async () => binding().Endpoint.bind(),
        createServer: onConnection => net.createServer(onConnection),
        dial: async (endpoint, t) =>
          (endpoint as IrohEndpoint).connect(binding().EndpointTicket.fromString(t).endpointAddr(), IROH_ALPN)
      })
    },
    list: () => [...tunnels.values()].map(h => h.tunnel),
    async teardownTicket(ticket: string): Promise<void> {
      const handle = tunnels.get(ticket)

      if (handle) {
        await handle.tunnel.teardown().catch(() => {})
        tunnels.delete(ticket)
      }
    }
  }
}
