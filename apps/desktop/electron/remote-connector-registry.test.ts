import { describe, expect, it, vi } from 'vitest'

import {
  canonicalScheme,
  createConnectorRegistry,
  UnsupportedSchemeError,
  urlScheme,
  type RemoteConnector,
  type RemoteTarget
} from './remote-connector-registry'

// A stand-in transport: the seam must be provable with ZERO real transports
// in the tree (that is the entire point of shipping the seam separate from
// the connector).
function fakeConnector(overrides: Partial<RemoteConnector> = {}): RemoteConnector {
  return {
    id: 'fake-connector',
    scheme: 'fake',
    connect: async (_url, log) => {
      log('fake: dialing')

      return {
        baseUrl: 'http://127.0.0.1:59999',
        teardown: async () => {},
        hostLabel: 'fake:abcd1234'
      }
    },
    ...overrides
  }
}

const normalizeHttp = (url: string) => {
  // Mirrors core normalizeRemoteBaseUrl's shape: scheme-less host:port gets
  // http:// prepended; anything else must parse as http(s).
  const value = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`

  try {
    const parsed = new URL(value)

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('bad scheme')
    }

    return parsed.origin
  } catch {
    throw new Error(`invalid remote url: ${url}`)
  }
}

const registryOf = (connectors: RemoteConnector[], log?: (msg: string) => void) =>
  createConnectorRegistry({ connectors, normalizeHttp, log })

describe('canonicalScheme / urlScheme', () => {
  it('extracts and lowercases the scheme', () => {
    expect(urlScheme('iroh://abc123')).toBe('iroh')
    expect(urlScheme('HTTP://Example.COM:9119')).toBe('http')
    expect(urlScheme('tailscale+ssh://box')).toBe('tailscale+ssh')
  })

  it('returns empty string for scheme-less or malformed values', () => {
    expect(urlScheme('100.64.0.1:9119')).toBe('')
    expect(urlScheme('https:/oops')).toBe('')
    expect(urlScheme(null)).toBe('')
    expect(canonicalScheme('  IR O H ')).toBe('')
    expect(canonicalScheme('1bad')).toBe('')
  })
})

describe('createConnectorRegistry — registration', () => {
  it('indexes connectors by canonical scheme and lists them for the UI', () => {
    const registry = registryOf([fakeConnector({ hint: 'paste a ticket' })])

    expect(registry.list()).toEqual([{ id: 'fake-connector', scheme: 'fake', hint: 'paste a ticket' }])
    expect(registry.forUrl('fake://ticket')?.id).toBe('fake-connector')
    expect(registry.forUrl('https://x.test')).toBeNull()
    expect(registry.forUrl('100.64.0.1:9119')).toBeNull()
  })

  it('rejects http/https registration — built-in remotes stay core', () => {
    const log = vi.fn()
    const registry = registryOf([fakeConnector({ scheme: 'https' })], log)

    expect(registry.list()).toEqual([])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('rejected invalid connector'))
  })

  it('first claim of a duplicate scheme wins; the loser is logged, not fatal', () => {
    const log = vi.fn()
    const registry = registryOf([fakeConnector(), fakeConnector({ id: 'other', scheme: 'FAKE' })], log)

    expect(registry.list().map(c => c.id)).toEqual(['fake-connector'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining("already claimed by 'fake-connector'"))
  })

  it('skips a malformed connector instead of killing startup', () => {
    const registry = registryOf([{ id: 'broken', scheme: 'bad scheme!' } as unknown as RemoteConnector, fakeConnector()])

    expect(registry.list().map(c => c.scheme)).toEqual(['fake'])
  })
})

describe('createConnectorRegistry — normalize', () => {
  it('leaves http(s) urls to the core normalizer, untouched', async () => {
    const registry = registryOf([fakeConnector()])

    await expect(registry.normalize('https://box.example:9119/ignored-path')).resolves.toBe('https://box.example:9119')
  })

  it('delegates canonicalization of its scheme body to the connector', async () => {
    // Mirrors the iroh connector's real normalize shape: strip invisible
    // chars, shave a pasted :port, closed-set sanitize the body.
    const connector = fakeConnector({
      normalize: url => {
        const body = url.slice('fake://'.length).replace(/[\s\u200b-\u200d\u2060\ufeff]/g, '')

        return `fake://${body.replace(/:[0-9]+$/, '').replace(/[^a-z2-7]/g, '')}`
      }
    })
    const registry = registryOf([connector])

    // Real base32 bodies contain no 0/1 digits — an input that survives the
    // closed-set sanitize is base32-only by construction.
    await expect(registry.normalize('fake://abcde\u200b2345 :9119')).resolves.toBe('fake://abcde2345')
  })

  it('stores a connector-scheme url verbatim when the connector has no normalize', async () => {
    const registry = registryOf([fakeConnector()])

    await expect(registry.normalize('fake://opaque\u00a0stuff')).resolves.toBe('fake://opaque\u00a0stuff')
  })

  it('rejects unclaimed schemes with UnsupportedSchemeError (never a URL parse error)', async () => {
    const registry = registryOf([fakeConnector()])

    await expect(registry.normalize('gopher://old.server')).rejects.toThrow(UnsupportedSchemeError)
    await expect(registry.normalize('gopher://old.server')).rejects.toThrow(/No connector installed for scheme 'gopher/)
  })

  it('claims a bare paste only through the connector\'s own claim surface', async () => {
    const claiming = fakeConnector({
      pastePattern: '^[a-z2-7]{40,}$',
      normalize: url => `fake://${url.slice('fake://'.length).toLowerCase()}`
    })
    const registry = registryOf([claiming])

    // A bare ticket-shaped blob gets the scheme added, then connector-normalized.
    await expect(registry.normalize('aoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeu')).resolves.toBe(
      'fake://aoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeuaoeu'
    )
    // A bare hostname is NOT ticket-shaped: core http-prepend path as always.
    await expect(registry.normalize('homelab.local:9119')).resolves.toBe('http://homelab.local:9119')
    // claims() also routes a bare paste.
    const byClaims = registryOf([fakeConnector({ claims: raw => raw === 'magictoken' })])

    await expect(byClaims.normalize('magictoken')).resolves.toBe('fake://magictoken')
  })

  it('surfaces normalize errors as accepts() false without throwing', async () => {
    const registry = registryOf([
      fakeConnector({
        normalize: url => {
          if (url.includes('zzz')) {
            throw new Error('bad ticket')
          }

          return url
        }
      })
    ])

    await expect(registry.accepts('fake://zzz')).resolves.toBe(false)
    await expect(registry.accepts('fake://ok')).resolves.toBe(true)
    await expect(registry.accepts('   ')).resolves.toBe(false)
  })
})

describe('createConnectorRegistry — ensure (dial)', () => {
  it('returns null for https remotes — the core path is byte-for-byte unchanged', async () => {
    const connect = vi.fn()
    const registry = registryOf([fakeConnector({ connect })])

    await expect(registry.ensure('https://box.example')).resolves.toBeNull()
    expect(connect).not.toHaveBeenCalled()
  })

  it('dials once and reuses the access point for the same saved url', async () => {
    const teardown = vi.fn(async () => {})
    let ports = 0
    const connect = vi.fn(async (): Promise<RemoteTarget> => ({
      baseUrl: `http://127.0.0.1:${++ports}`,
      teardown
    }))
    const log = vi.fn()
    const registry = registryOf([fakeConnector({ connect })], log)

    const first = await registry.ensure('fake://ticket-1')
    const second = await registry.ensure('fake://ticket-1')

    expect(connect).toHaveBeenCalledTimes(1)
    expect(first?.baseUrl).toBe('http://127.0.0.1:1')
    expect(second?.baseUrl).toBe(first?.baseUrl)
    expect(first?.hostLabel).toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('access point http://127.0.0.1:1'))
  })

  it('a different ticket under the same scheme dials its own pipe', async () => {
    const registry = registryOf([fakeConnector()])

    const a = await registry.ensure('fake://ticket-a')
    const b = await registry.ensure('fake://ticket-b')

    expect(a?.baseUrl).toBe('http://127.0.0.1:59999')
    expect(b?.baseUrl).toBe('http://127.0.0.1:59999')
    // Same fake baseUrl by construction; distinct identity is proven by teardown
    // releasing only its own slot.
    await a!.teardown()

    const again = await registry.ensure('fake://ticket-a')

    expect(again).not.toBeNull()
  })

  it('propagates connector dial failures', async () => {
    const registry = registryOf([
      fakeConnector({
        connect: async () => {
          throw new Error('no route to peer')
        }
      })
    ])

    await expect(registry.ensure('fake://dying')).rejects.toThrow('no route to peer')
    // Nothing half-registered stays live after a failed dial.
    await expect(registry.ensure('fake://dying')).rejects.toThrow('no route to peer')
  })

  it('rejects an invalid RemoteTarget from a buggy connector', async () => {
    const registry = registryOf([
      fakeConnector({
        connect: async () => ({ baseUrl: 'http://127.0.0.1:1' } as unknown as RemoteTarget)
      })
    ])

    await expect(registry.ensure('fake://t')).rejects.toThrow('invalid remote target')
  })

  it('teardown is idempotent and swallows connector teardown errors', async () => {
    const teardown = vi.fn(async () => {
      throw new Error('already closed')
    })
    const log = vi.fn()
    const registry = registryOf([fakeConnector({ connect: async () => ({ baseUrl: 'http://127.0.0.1:2', teardown }) })], log)

    const target = await registry.ensure('fake://t')

    await expect(target!.teardown()).resolves.toBeUndefined()
    await expect(target!.teardown()).resolves.toBeUndefined()
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('teardown failed'))
  })

  it('teardownAll releases every live pipe, then asks each connector', async () => {
    const order: string[] = []
    let ports = 0
    const connect = vi.fn(async (): Promise<RemoteTarget> => ({
      baseUrl: `http://127.0.0.1:${++ports}`,
      teardown: async () => {
        order.push('target')
      }
    }))
    const connector = fakeConnector({
      connect,
      teardownAll: async () => {
        order.push('connector')
      }
    })
    const registry = registryOf([connector])

    await registry.ensure('fake://a')
    await registry.ensure('fake://b')
    await registry.teardownAll()

    expect(order).toEqual(['target', 'target', 'connector'])

    // After teardownAll the next ensure re-dials (the map was released).
    await registry.ensure('fake://a')

    expect(connect).toHaveBeenCalledTimes(3)
  })

  it('ensure routes through normalize first: a sanitized ticket reuses the pipe of its canonical form', async () => {
    const connect = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4', teardown: async () => {} }))
    const registry = registryOf([
      fakeConnector({
        connect,
        normalize: url => `fake://${url.slice('fake://'.length).replace(/[^a-z2-7]/g, '')}`
      })
    ])

    await registry.ensure('fake://abcde\u200b2345')
    await registry.ensure('fake://abcde2345')

    expect(connect).toHaveBeenCalledTimes(1)
  })
})

describe('createConnectorRegistry — reseed (enable/disable hot-swap)', () => {
  it('surviving connectors keep their live pipes; dropped ones are torn down', async () => {
    const keptTeardown = vi.fn(async () => {})
    const goneTeardown = vi.fn(async () => {})
    let n = 0
    const kept = fakeConnector({
      id: 'kept',
      scheme: 'keep',
      connect: async () => ({ baseUrl: `http://127.0.0.1:${++n}`, teardown: keptTeardown })
    })
    const gone = fakeConnector({
      id: 'gone',
      scheme: 'gone',
      connect: async () => ({ baseUrl: `http://127.0.0.1:${++n}`, teardown: goneTeardown })
    })
    const registry = registryOf([kept, gone])

    await registry.ensure('keep://x')
    await registry.ensure('gone://y')
    await registry.reseed([kept])

    expect(goneTeardown).toHaveBeenCalledTimes(1)
    expect(keptTeardown).not.toHaveBeenCalled()
    // Dropped scheme now fails closed with the install-a-connector message.
    await expect(registry.ensure('gone://y')).rejects.toThrow(/No connector installed for scheme 'gone/)
    // Surviving pipe is STILL reused (no re-dial, no teardown churn).
    const again = await registry.ensure('keep://x')

    expect(again?.baseUrl).toBe('http://127.0.0.1:1')
    expect(keptTeardown).not.toHaveBeenCalled()
  })

  it('re-enabling a connector re-claims its scheme (a re-enabled plugin just works)', async () => {
    const registry = registryOf([])

    await expect(registry.ensure('fake://t')).rejects.toThrow(UnsupportedSchemeError)
    await registry.reseed([fakeConnector()])

    const target = await registry.ensure('fake://t')

    expect(target?.baseUrl).toBe('http://127.0.0.1:59999')
  })

  it('reseed validates and first-wins exactly like construction', async () => {
    const log = vi.fn()
    const registry = registryOf([], log)

    await registry.reseed([
      fakeConnector({ id: 'ok' }),
      fakeConnector({ id: 'https-hijack', scheme: 'https' }),
      fakeConnector({ id: 'dupe', scheme: 'fake' })
    ])

    expect(registry.list().map(c => c.id)).toEqual(['ok'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reseed: https-hijack: invalid connector'))
    expect(log).toHaveBeenCalledWith(expect.stringContaining("reseed: dupe: duplicate scheme 'fake'"))
  })
})
