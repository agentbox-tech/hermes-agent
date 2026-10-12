import assert from 'node:assert/strict'
import net from 'node:net'

import { describe, it } from 'vitest'

import {
  deterministicLoopbackPorts,
  ensureIrohTunnel,
  IROH_SCHEME,
  type IrohTunnel,
  isIrohUrl,
  LOOPBACK_PORT_BASE,
  LOOPBACK_PORT_SPAN,
  LOOPBACK_PORT_TRIES,
  normalizeIrohUrl,
  parseIrohTicket
} from './iroh-connection'

// Real base32 endpoint ticket (parsed by the binding; never dialled here).
const TICKET =
  'endpointadu2n5bd64n24e3jqrh2poctujp7uun3iiqgsshakmf3gqifp7a3sbabacwbakqb5csagaiayculeaxiuqbqcajkaaab7fufwaasmntgy2k2e4lvw2cqeaibfiaaah4wqwyadjtg5v5z6ult4s3ikaq'

describe('isIrohUrl', () => {
  it('accepts the scheme case-insensitively, with surrounding whitespace', () => {
    assert.equal(isIrohUrl(`${IROH_SCHEME}${TICKET}`), true)
    assert.equal(isIrohUrl(`  IROH://${TICKET}  `), true)
  })

  it('rejects http(s) urls and non-strings', () => {
    assert.equal(isIrohUrl('http://127.0.0.1:9119'), false)
    assert.equal(isIrohUrl('https://dashboard.example.com'), false)
    assert.equal(isIrohUrl(undefined), false)
    assert.equal(isIrohUrl(42), false)
  })
})

describe('parseIrohTicket', () => {
  it('accepts a bare ticket and an iroh:// url', () => {
    assert.equal(parseIrohTicket(TICKET), TICKET)
    assert.equal(parseIrohTicket(`${IROH_SCHEME}${TICKET}`), TICKET)
  })

  it('rejects empty and malformed tickets', () => {
    assert.throws(() => parseIrohTicket(''), /need a ticket/)
    assert.throws(() => parseIrohTicket(`${IROH_SCHEME}!!!not-base32!!!`), /valid iroh ticket/)
  })
})

describe('normalizeIrohUrl', () => {
  it('canonicalizes both input shapes to scheme + ticket', () => {
    assert.equal(normalizeIrohUrl(`${IROH_SCHEME}${TICKET}`), `${IROH_SCHEME}${TICKET}`)
    assert.equal(normalizeIrohUrl(` ${TICKET} `), `${IROH_SCHEME}${TICKET}`)
  })
})

interface FakeCounters {
  bound: number
  closed: number
  ports: number[]
}

function makeDeps(tunnels: Map<string, any>, counters: FakeCounters): any {
  const fakeConn = () => ({
    close: () => {},
    closeReason: () => null,
    openBi: async () => ({
      recv: { read: async () => [] as number[] },
      send: { finish: async () => {}, reset: () => {}, writeAll: async () => {} }
    }),
    remoteId: () => ({ fmtShort: () => 'fake0short' })
  })

  return {
    bindEndpoint: async () => {
      counters.bound++

      return { close: async () => { counters.closed++ } }
    },
    createServer: (onConnection: (socket: net.Socket) => void) => {
      const server = new net.Server()
      server.on('connection', onConnection)

      return server
    },
    dial: async () => fakeConn(),
    log: () => {},
    pickPort: async () => {
      const port = 20000 + counters.ports.length
      counters.ports.push(port)

      return [port]
    },
    tunnels
  }
}

describe('ensureIrohTunnel', () => {
  it('binds + listens and exposes an http loopback baseUrl', async () => {
    const counters: FakeCounters = { bound: 0, closed: 0, ports: [] }
    const tunnels = new Map<string, any>()
    const tunnel: IrohTunnel = await ensureIrohTunnel('conn-iroh-1', `${IROH_SCHEME}${TICKET}`, makeDeps(tunnels, counters))

    assert.equal(tunnel.baseUrl, `http://127.0.0.1:${tunnel.port}`)
    assert.equal(tunnel.ticket, TICKET)
    assert.equal(counters.bound, 1)
    assert.equal(tunnels.size, 1)
    await tunnel.teardown()
    assert.equal(counters.closed, 1)
  })

  it('reuses the live tunnel for the same ticket', async () => {
    const counters: FakeCounters = { bound: 0, closed: 0, ports: [] }
    const tunnels = new Map<string, any>()
    const deps = makeDeps(tunnels, counters)

    const first = await ensureIrohTunnel('conn-iroh-1', `${IROH_SCHEME}${TICKET}`, deps)
    const second = await ensureIrohTunnel('conn-iroh-1', `${IROH_SCHEME}${TICKET}`, deps)

    assert.equal(first, second)
    assert.equal(counters.bound, 1)
    await first.teardown()
  })

  it('rebinds when the previous tunnel stopped listening', async () => {
    const counters: FakeCounters = { bound: 0, closed: 0, ports: [] }
    const tunnels = new Map<string, any>()
    const deps = makeDeps(tunnels, counters)

    const first = await ensureIrohTunnel('conn-iroh-1', `${IROH_SCHEME}${TICKET}`, deps)
    await first.teardown()

    const second = await ensureIrohTunnel('conn-iroh-1', `${IROH_SCHEME}${TICKET}`, deps)

    assert.notEqual(first, second)
    assert.equal(counters.bound, 2)
    assert.equal(counters.ports.length, 2)
    await second.teardown()
  })

  it('walks to the next candidate when the first port is busy', async () => {
    const tunnels = new Map<string, any>()
    const boundPorts: number[] = []

    const deps = {
      bindEndpoint: async () => ({ close: async () => {} }),
      createServer: (onConnection: (socket: net.Socket) => void) => {
        const server = new net.Server()
        server.on('connection', onConnection)

        return server
      },
      dial: async () => ({
        close: () => {},
        closeReason: () => null,
        openBi: async () => ({
          recv: { read: async () => [] as number[] },
          send: { finish: async () => {}, reset: () => {}, writeAll: async () => {} }
        }),
        remoteId: () => ({ fmtShort: () => 'fake0short' })
      }),
      log: () => {},
      // first candidate is taken by a live competitor; second must win
      pickPort: async () => {
        const busy = new net.Server()
        await new Promise<void>(resolve => busy.listen(21500, '127.0.0.1', resolve))

        return [21500, 21501]
      },
      tunnels
    }

    const tunnel = await ensureIrohTunnel('conn-iroh-1', `${IROH_SCHEME}${TICKET}`, deps as any)

    assert.equal(tunnel.port, 21501)
    await tunnel.teardown()
  })
})

describe('deterministicLoopbackPorts', () => {
  it('is stable per seed, in range, and walks forward', () => {
    const a = deterministicLoopbackPorts('ticket-abc')
    const b = deterministicLoopbackPorts('ticket-abc')

    assert.deepEqual(a, b)
    assert.equal(a.length, LOOPBACK_PORT_TRIES)
    assert.ok(a[0]! >= LOOPBACK_PORT_BASE && a[0]! < LOOPBACK_PORT_BASE + LOOPBACK_PORT_SPAN)
    assert.equal(a[1]! - a[0]!, 1)
    assert.notDeepEqual(a, deterministicLoopbackPorts('ticket-xyz'))
  })
})
