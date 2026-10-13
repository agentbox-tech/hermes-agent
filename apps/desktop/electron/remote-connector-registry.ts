/**
 * remote-connector-registry.ts
 *
 * THE SEAM for remote gateway connectors: a named transport implementation
 * registers a URL scheme (`iroh://`, `tailscale+ssh://`, …) and owns every
 * step of turning a saved connection url into a live loopback endpoint the
 * app can talk plain HTTP to.
 *
 * The contract that makes this generic: downstream of `connect()` everything
 * is a plain remote descriptor with `baseUrl: http://127.0.0.1:<port>` —
 * fetch, WS upgrade, token adoption and revalidation ride the pipe without
 * knowing which transport sits underneath. The connector owns its ENTIRE
 * pipe (bind its loopback port, pump bytes over its wire), so the main
 * process only ever handles serializable data: a baseUrl string plus a
 * teardown closure. (This is what lets a future hardened loader run
 * connectors in worker_threads with a declared-permission manifest without
 * changing this interface at all.)
 *
 * Design rules:
 *  - `http(s)` is NOT registrable — built-in https remotes stay core and
 *    untouched. A connector registering `http` is rejected by the loader.
 *  - Saved urls are OPAQUE to core: scheme selection is the connector's
 *    dispatch key, and canonicalization of a scheme's body is the
 *    connector's `normalize()`. Core never parses a connector's pairing
 *    material (a ticket is not a hostname).
 *  - A connector-backed remote is persisted as a plain `remote` connection
 *    whose url carries the connector's scheme — there is deliberately no
 *    kind enum to extend per transport.
 *
 * Kept standalone (no `import 'electron'`) so it unit-tests with plain
 * vitest — same pattern as connection-registry.ts / backend-probes.ts.
 * main.ts builds the registry and wires it into the IPC layer.
 */

/** The shape every URL-consuming site eventually sees: a live local access
 * point for the remote gateway, plus the teardown that closes it. */
export interface RemoteTarget {
  /** Loopback origin the app speaks plain HTTP/WS against. */
  baseUrl: string
  /** Close the access point (idempotent; errors are the connector's to swallow). */
  teardown: () => Promise<void>
  /** Optional human pill label (e.g. `iroh:c674b504`) — the baseUrl tunnel
   * address is meaningless to show, and core has no scheme vocabulary to
   * build one itself. */
  hostLabel?: string
  /** Optional live status for surfaces that want it; must be cheap. */
  status?: () => ConnectorStatus
}

export type ConnectorState = 'idle' | 'connecting' | 'online' | 'error'

export interface ConnectorStatus {
  state: ConnectorState
  detail?: string
}

/** A transport implementation registered by id + scheme. */
export interface RemoteConnector {
  /** Globally unique connector id (the plugin id, e.g. 'iroh-connector'). */
  id: string
  /** Dispatch scheme WITHOUT `://` (e.g. 'iroh'). Lowercase, RFC3986 shape. */
  scheme: string
  /** Add-Connection UI hint ("paste the ticket from the remote box…"). */
  hint?: string
  /** Optional regex SOURCE for opaque pasted pairing material (bare tickets)
   * the connector claims even without its scheme prefix. Core compiles and
   * tests it generically — it never hardcodes a pairing format. */
  pastePattern?: string
  /** Canonicalize a saved url for this scheme (called at save time). May be
   * async (a native ticket parse). Throw on input this connector cannot dial. */
  normalize?: (url: string) => string | Promise<string>
  /** Claim a scheme-less pasted value (bare ticket). Only consulted by
   * `normalize`/`accepts` when no scheme matched. */
  claims?: (raw: string) => boolean
  /** Bring up a local access point for `savedUrl`. Idempotent per saved url. */
  connect: (url: string, log: (msg: string) => void) => Promise<RemoteTarget>
  /** Close every access point this connector holds (app shutdown). */
  teardownAll?: () => Promise<void>
}

const BUILT_IN_SCHEMES = new Set(['http', 'https'])

/** Normalize a scheme token: lowercase. Returns '' for anything that is not
 * a valid RFC3986 scheme-shaped token. */
export function canonicalScheme(scheme: unknown): string {
  if (typeof scheme !== 'string') {
    return ''
  }

  const value = scheme.trim().toLowerCase()

  return /^[a-z][a-z0-9+.-]*$/.test(value) ? value : ''
}

/** `iroh://ticket` → `iroh`; `http://x` → `http`; anything without a
 * `<scheme>://` prefix → ''. Case-insensitive on the scheme. */
export function urlScheme(url: unknown): string {
  if (typeof url !== 'string') {
    return ''
  }

  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim())

  return match ? canonicalScheme(match[1]) : ''
}

/** Generic pill label for a connector-backed remote: `scheme:<first 8 of
 * body>` (e.g. `iroh:c674b504`). Lives here so no consumer needs to know
 * any scheme's pairing format, and the loopback tunnel address never leaks
 * into the UI pill. */
export function connectorHostLabel(url: unknown): string {
  const scheme = urlScheme(url)

  if (!scheme) {
    return ''
  }

  const body = String(url).trim().slice(`${scheme}://`.length)

  return `${scheme}:${body.slice(0, 8)}`
}

/** Raised when a url names a scheme no installed connector implements, so
 * callers fail with "install a connector for `iroh://`" instead of a URL
 * parse error or a hung probe. */
export class UnsupportedSchemeError extends Error {
  readonly scheme: string

  constructor(scheme: string) {
    super(`No connector installed for scheme '${scheme}://'`)
    this.name = 'UnsupportedSchemeError'
    this.scheme = scheme
  }
}

export interface ConnectorSummary {
  id: string
  scheme: string
  hint?: string
  pastePattern?: string
}

export interface ConnectorRegistry {
  /** UI-facing inventory (Add-Connection list, settings). */
  list(): ConnectorSummary[]
  /** The connector owning `url`'s scheme, or null for http(s)/scheme-less. */
  forUrl(url: unknown): RemoteConnector | null
  /** True iff core or a connector can canonicalize this raw pasted value. */
  accepts(raw: unknown): Promise<boolean>
  /** Canonical saved form: the connector's `normalize` for its scheme, the
   * core https normalizer otherwise. Rejects for unclaimed schemes. */
  normalize(raw: unknown): Promise<string>
  /** Bring up (idempotently) the access point for a saved url. Returns null
   * for plain https remotes — the caller then uses the core https path
   * exactly as before. Rejects UnsupportedSchemeError / connector errors. */
  ensure(url: unknown, log?: (msg: string) => void): Promise<RemoteTarget | null>
  /** Close everything (app shutdown). */
  teardownAll(): Promise<void>
  /** Hot-swap the connector set (renderer enable/disable pushes); pipes of
   * surviving connectors are untouched. */
  reseed(next: RemoteConnector[]): Promise<void>
}

/**
 * Build the dispatch registry.
 *
 * @param connectors validated connector instances (loader output); duplicate
 * schemes never reach here (the loader resolves collisions).
 * @param normalizeHttp the core https normalizer (`normalizeRemoteBaseUrl`)
 * injected so this module stays free of connection-config imports.
 */
export function createConnectorRegistry({
  connectors = [],
  normalizeHttp,
  log = () => {}
}: {
  connectors?: RemoteConnector[]
  normalizeHttp: (url: string) => string
  log?: (msg: string) => void
}): ConnectorRegistry {
  const byScheme = new Map<string, RemoteConnector>()

  for (const connector of connectors) {
    const scheme = canonicalScheme(connector.scheme)

    if (!scheme || BUILT_IN_SCHEMES.has(scheme) || typeof connector.connect !== 'function') {
      log(`[connectors] rejected invalid connector ${JSON.stringify(connector?.id)} (scheme='${connector?.scheme}')`)

      continue
    }

    if (byScheme.has(scheme)) {
      log(`[connectors] scheme '${scheme}://' already claimed by '${byScheme.get(scheme)!.id}' — ignoring '${connector.id}'`)

      continue
    }

    byScheme.set(scheme, connector)
  }

  /** Connector claiming a scheme-less value via a declared pastePattern. */
  function claimerForBare(raw: string): RemoteConnector | null {
    for (const connector of byScheme.values()) {
      try {
        if (connector.claims?.(raw)) {
          return connector
        }

        if (connector.pastePattern && new RegExp(connector.pastePattern, 'i').test(raw)) {
          return connector
        }
      } catch (err) {
        log(`[connectors] '${connector.id}' claim probe failed: ${String((err as Error)?.message ?? err)}`)
      }
    }

    return null
  }

  function resolve(raw: string): { connector: null | RemoteConnector; canonical: string } {
    const scheme = urlScheme(raw)

    if (!scheme || scheme === 'http' || scheme === 'https') {
      // Core path — but a bare opaque paste (no scheme at all) may belong to
      // a connector (a pasted ticket is not a hostname; http-prepending it
      // would mangle pairing material).
      if (!scheme) {
        const claimer = claimerForBare(raw.trim())

        if (claimer) {
          return { connector: claimer, canonical: `${claimer.scheme}://${raw.trim()}` }
        }
      }

      return { connector: null, canonical: '' }
    }

    const connector = byScheme.get(scheme)

    if (!connector) {
      throw new UnsupportedSchemeError(scheme)
    }

    return { connector, canonical: '' }
  }

  async function normalize(raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new Error('Remote gateway URL is required.')
    }

    const value = raw.trim()
    const { connector, canonical } = resolve(value)

    if (canonical) {
      // Claimed bare paste: add the scheme, then let the connector canonicalize
      // the body (sanitization is the connector's contract).
      return connector!.normalize ? String(await connector!.normalize(canonical)) : canonical
    }

    if (!connector) {
      return normalizeHttp(value)
    }

    return connector.normalize ? String(await connector.normalize(value)) : value
  }

  async function accepts(raw: unknown): Promise<boolean> {
    try {
      await normalize(raw)

      return true
    } catch {
      return false
    }
  }

  // Live access points keyed by CONNECTOR id + canonical saved url: the same
  // saved url must reuse its pipe (idempotent), a changed url gets a new one.
  const live = new Map<string, RemoteTarget>()

  /** Swap the registered connector set (enable/disable hot-changes) WITHOUT
   * disturbing the pipes of connectors that remain: a toggle of plugin X
   * must not silently log the user out of remote Y. Dropped connectors get
   * their pipes torn down, then their own teardownAll. */
  async function reseed(next: RemoteConnector[]): Promise<void> {
    const nextByScheme = new Map<string, RemoteConnector>()
    const issues: string[] = []

    for (const connector of next) {
      const scheme = canonicalScheme(connector.scheme)

      if (!scheme || BUILT_IN_SCHEMES.has(scheme) || typeof connector.connect !== 'function') {
        issues.push(`${connector?.id}: invalid connector`)

        continue
      }

      if (nextByScheme.has(scheme)) {
        issues.push(`${connector.id}: duplicate scheme '${scheme}'`)

        continue
      }

      nextByScheme.set(scheme, connector)
    }

    byScheme.clear()

    for (const [scheme, connector] of nextByScheme) {
      byScheme.set(scheme, connector)
    }

    const survivingIds = new Set([...nextByScheme.values()].map(c => c.id))
    const droppedKeys = [...live.keys()].filter(key => !survivingIds.has(key.split('\u0000')[0]))

    for (const key of droppedKeys) {
      const target = live.get(key)

      live.delete(key)

      try {
        await target?.teardown()
      } catch (err) {
        log(`[connectors] teardown on reseed failed: ${String((err as Error)?.message ?? err)}`)
      }
    }

    for (const message of issues) {
      log(`[connectors] reseed: ${message}`)
    }
  }

  async function ensure(url: unknown, callerLog?: (msg: string) => void): Promise<RemoteTarget | null> {
    const emit = callerLog ?? log
    const savedUrl = await normalize(url)
    const scheme = urlScheme(savedUrl)
    const connector = scheme ? byScheme.get(scheme) ?? null : null

    if (!connector) {
      return null
    }

    const key = `${connector.id}\u0000${savedUrl}`
    const existing = live.get(key)

    if (existing) {
      return existing
    }

    emit(`[connectors] ${connector.id}: dialing ${savedUrl.slice(0, 48)}…`)

    const target = await connector.connect(savedUrl, emit)

    if (!target || typeof target.baseUrl !== 'string' || typeof target.teardown !== 'function') {
      throw new Error(`Connector '${connector.id}' returned an invalid remote target`)
    }

    live.set(key, target)
    emit(`[connectors] ${connector.id}: access point ${target.baseUrl}`)

    let closed = false

    const managed: RemoteTarget = {
      baseUrl: target.baseUrl,
      hostLabel: target.hostLabel,
      status: target.status,
      teardown: async () => {
        // Once-only at the registry level: a second teardown of the same
        // saved url (e.g. delete-connection racing app shutdown) must not
        // re-enter the connector's close path.
        if (closed) {
          return
        }

        closed = true
        live.delete(key)

        try {
          await target.teardown()
        } catch (err) {
          emit(`[connectors] ${connector.id}: teardown failed: ${String((err as Error)?.message ?? err)}`)
        }
      }
    }

    // Callers hold the returned object without re-fetching it, so the map
    // keeps the MANAGED wrapper (teardown must also release the slot).
    live.set(key, managed)

    return managed
  }

  async function teardownAll(): Promise<void> {
    const targets = [...live.values()]

    live.clear()

    await Promise.all(
      targets.map(async target => {
        await target.teardown().catch(() => {})
      })
    )

    await Promise.all(
      [...byScheme.values()].map(async connector => {
        await connector.teardownAll?.().catch(err =>
          log(`[connectors] '${connector.id}' teardownAll failed: ${String((err as Error)?.message ?? err)}`)
        )
      })
    )
  }

  return {
    list: () =>
      [...byScheme.values()].map(({ id, scheme, hint, pastePattern }) => ({
        id,
        scheme,
        ...(hint ? { hint } : {}),
        ...(pastePattern ? { pastePattern } : {})
      })),
    forUrl: (url): RemoteConnector | null => {
      const scheme = urlScheme(url)

      return scheme ? byScheme.get(scheme) ?? null : null
    },
    accepts,
    normalize,
    ensure,
    teardownAll,
    reseed
  }
}
