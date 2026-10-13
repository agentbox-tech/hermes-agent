/**
 * remote-connector-loader.ts
 *
 * MAIN-process discovery of remote gateway connectors dropped into the
 * desktop plugin tree. This is the one genuinely new capability in the seam:
 * desktop plugins are renderer code (`plugin.js` runs in the window);
 * connectors run in the MAIN process because they own sockets.
 *
 * Contract:
 *  - A connector lives at `<desktop-plugins-root>/<name>/connector.mjs`
 *    (or `connector.js`) and default-exports a `RemoteConnector`-shaped
 *    object. The renderer half (`plugin.js`) stays OPTIONAL — a connector
 *    folder with only `connector.mjs` adds zero UI and still works; the
 *    generic Add-Connection UI surfaces `scheme` + `hint` from the registry.
 *  - Validation happens here, once, at load: id + RFC3986 scheme + callable
 *    `connect`; `http`/`https` are refused (built-in remotes stay core);
 *    duplicate scheme claims are first-wins with a warning. A folder that
 *    throws at import is skipped — one bad connector must never brick the
 *    app's connection layer.
 *  - Enable/disable reuses the SAME persisted state as renderer plugins
 *    (`pluginActive`, Settings → Plugins): one row per plugin id controls
 *    both halves.
 *
 * Sandbox posture (dogfood v1): `import()` in the main process — the exact
 * trust level the SAME file already has when loaded as a renderer plugin by
 * the same install flow, so no new capability is granted by THIS module.
 * The hardened posture for review: spawn each connector inside a
 * worker_thread with a declared-permission manifest; the registry contract
 * passes only serializable data (baseUrl string + teardown), so that
 * upgrade does not change any interface here. See the task DESIGN doc.
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { canonicalScheme, type RemoteConnector } from './remote-connector-registry'

export const CONNECTOR_MODULE_BASENAMES = ['connector.mjs', 'connector.js'] as const

const BUILT_IN_SCHEMES = new Set(['http', 'https'])

export interface ConnectorLoadIssue {
  /** Plugin folder name (stable even when the module never loaded). */
  folder: string
  /** What we tried (module path) or the connector id when validation got that far. */
  detail: string
}

export interface ConnectorLoadResult {
  connectors: RemoteConnector[]
  /** Non-fatal per-folder problems, for logs + the Plugins settings surface. */
  issues: ConnectorLoadIssue[]
}

/** Validate an imported module's default export. Returns null (with a
 * human-readable reason) for anything unusable. */
export function validateConnectorModule(mod: unknown): { connector: null | RemoteConnector; reason: null | string } {
  const connector = (mod as { default?: unknown })?.default as Partial<RemoteConnector> | undefined

  if (!connector || typeof connector !== 'object') {
    return { connector: null, reason: 'no default export' }
  }

  if (typeof connector.id !== 'string' || !connector.id.trim()) {
    return { connector: null, reason: 'missing id' }
  }

  const scheme = canonicalScheme(connector.scheme)

  if (!scheme) {
    return { connector: null, reason: `invalid scheme '${String(connector.scheme)}'` }
  }

  if (BUILT_IN_SCHEMES.has(scheme)) {
    return { connector: null, reason: `'${scheme}' is a built-in scheme and is not registrable` }
  }

  if (typeof connector.connect !== 'function') {
    return { connector: null, reason: 'connect is not a function' }
  }

  if (connector.claims !== undefined && typeof connector.claims !== 'function') {
    return { connector: null, reason: 'claims must be a function when present' }
  }

  if (connector.normalize !== undefined && typeof connector.normalize !== 'function') {
    return { connector: null, reason: 'normalize must be a function when present' }
  }

  if (connector.pastePattern !== undefined) {
    if (typeof connector.pastePattern !== 'string') {
      return { connector: null, reason: 'pastePattern must be a string when present' }
    }

    try {
      new RegExp(connector.pastePattern)
    } catch {
      return { connector: null, reason: 'pastePattern is not a valid regular expression' }
    }
  }

  return { connector: { ...connector, scheme } as RemoteConnector, reason: null }
}

/**
 * Discover + load every enabled connector under `root`.
 *
 * @param root the desktop-plugins root (from desktop-plugins-root.ts)
 * @param isEnabled plugin-enable predicate (defaults: enabled)
 * @param dynamicImport injectable import() (tests fake the module system)
 */
export async function loadRemoteConnectors({
  root,
  isEnabled = () => true,
  dynamicImport = (specifier: string) => import(specifier),
  log = () => {}
}: {
  root: string
  isEnabled?: (pluginId: string) => boolean | Promise<boolean>
  dynamicImport?: (specifier: string) => Promise<unknown>
  log?: (msg: string) => void
}): Promise<ConnectorLoadResult> {
  const connectors: RemoteConnector[] = []
  const issues: ConnectorLoadIssue[] = []
  const claimed = new Map<string, string>()

  let entries: fs.Dirent[] = []

  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true })
  } catch {
    // No desktop-plugins root yet — zero connectors is the normal state.
    return { connectors, issues }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue
    }

    const folder = entry.name

    const modulePath = CONNECTOR_MODULE_BASENAMES
      .map(basename => path.join(root, folder, basename))
      .find(candidate => fs.existsSync(candidate))

    if (!modulePath) {
      continue
    }

    if (!(await isEnabled(folder))) {
      log(`[connectors] '${folder}' is disabled — connector not loaded`)

      continue
    }

    let mod: unknown

    try {
      mod = await dynamicImport(pathToFileURL(modulePath).href)
    } catch (err) {
      const reason = String((err as Error)?.message ?? err)

      log(`[connectors] '${folder}' failed to import: ${reason}`)
      issues.push({ folder, detail: reason })

      continue
    }

    const { connector, reason } = validateConnectorModule(mod)

    if (!connector) {
      log(`[connectors] '${folder}' rejected: ${reason}`)
      issues.push({ folder, detail: reason ?? 'invalid connector' })

      continue
    }

    const existing = claimed.get(connector.scheme)

    if (existing) {
      log(`[connectors] '${folder}' claims '${connector.scheme}://' already owned by '${existing}' — ignored`)
      issues.push({ folder, detail: `duplicate scheme '${connector.scheme}' (owned by '${existing}')` })

      continue
    }

    claimed.set(connector.scheme, folder)
    connectors.push(connector)
    log(`[connectors] loaded '${connector.id}' claiming '${connector.scheme}://'`)
  }

  return { connectors, issues }
}
