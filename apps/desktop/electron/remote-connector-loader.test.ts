import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadRemoteConnectors, validateConnectorModule } from './remote-connector-loader'

const validConnector = {
  id: 'fake-connector',
  scheme: 'fake',
  hint: 'paste a fake ticket',
  connect: async () => ({ baseUrl: 'http://127.0.0.1:59999', teardown: async () => {} })
}

describe('validateConnectorModule', () => {
  it('accepts a well-shaped default export and canonicalizes the scheme', () => {
    const { connector, reason } = validateConnectorModule({ default: { ...validConnector, scheme: 'FAKE' } })

    expect(reason).toBeNull()
    expect(connector?.scheme).toBe('fake')
    expect(connector?.id).toBe('fake-connector')
  })

  it('refuses http/https registration — built-ins stay core', () => {
    expect(validateConnectorModule({ default: { ...validConnector, scheme: 'https' } }).reason).toMatch(/built-in/)
    expect(validateConnectorModule({ default: { ...validConnector, scheme: 'http' } }).reason).toMatch(/built-in/)
  })

  it('refuses malformed shapes with a named reason', () => {
    expect(validateConnectorModule(undefined).reason).toBe('no default export')
    expect(validateConnectorModule({}).reason).toBe('no default export')
    expect(validateConnectorModule({ default: 42 }).reason).toBe('no default export')
    expect(validateConnectorModule({ default: { scheme: 'fake', connect: () => {} } }).reason).toBe('missing id')
    expect(validateConnectorModule({ default: { id: 'x', connect: () => {} } }).reason).toMatch(/invalid scheme/)
    expect(validateConnectorModule({ default: { id: 'x', scheme: 'bad scheme!' } }).reason).toMatch(/invalid scheme/)
    expect(validateConnectorModule({ default: { id: 'x', scheme: 'fake' } }).reason).toBe('connect is not a function')
    expect(validateConnectorModule({ default: { ...validConnector, claims: 'nope' } }).reason).toMatch(/claims/)
    expect(validateConnectorModule({ default: { ...validConnector, normalize: 7 } }).reason).toMatch(/normalize/)
    expect(validateConnectorModule({ default: { ...validConnector, pastePattern: '([unclosed' } }).reason).toMatch(/regular expression/)
  })
})

const tmpRoots: string[] = []

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-connectors-'))

  tmpRoots.push(dir)

  return dir
}

afterEach(() => {
  while (tmpRoots.length) {
    fs.rmSync(tmpRoots.pop()!, { recursive: true, force: true })
  }
})

function writeConnectorFolder(root: string, name: string, source: string, basename = 'connector.mjs'): void {
  fs.mkdirSync(path.join(root, name), { recursive: true })
  fs.writeFileSync(path.join(root, name, basename), source)
}

describe('loadRemoteConnectors', () => {
  it('a missing desktop-plugins root is the normal zero-connector state, not an error', async () => {
    const result = await loadRemoteConnectors({ root: '/nonexistent/definitely-not-here' })

    expect(result).toEqual({ connectors: [], issues: [] })
  })

  it('loads a real connector.mjs from disk (real dynamic import)', async () => {
    const root = tmpRoot()

    writeConnectorFolder(
      root,
      'fake-plugin',
      `export default {
         id: 'fake-connector',
         scheme: 'fake',
         hint: 'paste a ticket',
         normalize: url => url.replace(/\\s+/g, ''),
         connect: async () => ({ baseUrl: 'http://127.0.0.1:59999', teardown: async () => {} })
       }`
    )

    const { connectors, issues } = await loadRemoteConnectors({ root })

    expect(issues).toEqual([])
    expect(connectors).toHaveLength(1)
    expect(connectors[0].id).toBe('fake-connector')
    expect(connectors[0].scheme).toBe('fake')
    expect(connectors[0].hint).toBe('paste a ticket')

    const target = await connectors[0].connect('fake://ticket', () => {})

    expect(target.baseUrl).toBe('http://127.0.0.1:59999')
  })

  it('connector.js is the CJS-adjacent alias; .mjs wins when both exist', async () => {
    const root = tmpRoot()

    writeConnectorFolder(root, 'p', `export default { id: 'from-mjs', scheme: 'mjs', connect: async () => ({}) }`)
    writeConnectorFolder(root, 'q', `export default { id: 'from-js', scheme: 'js', connect: async () => ({}) }`, 'connector.js')

    const { connectors } = await loadRemoteConnectors({ root })

    expect(connectors.map(c => c.id).sort()).toEqual(['from-js', 'from-mjs'])
  })

  it('one bad connector is an issue, never a brick', async () => {
    const root = tmpRoot()

    writeConnectorFolder(root, 'explodes', `throw new Error('top-level kaboom')`)
    writeConnectorFolder(root, 'shapeless', `export default { id: 'nope' }`)
    writeConnectorFolder(root, 'good', `export default { id: 'fake-connector', scheme: 'fake', connect: async () => ({ baseUrl: 'http://127.0.0.1:1', teardown: async () => {} }) }`)

    const { connectors, issues } = await loadRemoteConnectors({ root })

    expect(connectors.map(c => c.id)).toEqual(['fake-connector'])
    const folders = issues.map(i => i.folder)

    expect(folders).toContain('explodes')
    expect(folders).toContain('shapeless')
    expect(issues.find(i => i.folder === 'explodes')?.detail).toContain('kaboom')
  })

  it('duplicate scheme claims are first-wins (stable readdir order), loser reported', async () => {
    const root = tmpRoot()

    writeConnectorFolder(root, 'aaa', `export default { id: 'first', scheme: 'fake', connect: async () => ({ baseUrl: 'x', teardown: async () => {} }) }`)
    writeConnectorFolder(root, 'bbb', `export default { id: 'second', scheme: 'fake', connect: async () => ({ baseUrl: 'y', teardown: async () => {} }) }`)

    const { connectors, issues } = await loadRemoteConnectors({ root })

    expect(connectors.map(c => c.id)).toEqual(['first'])
    expect(issues).toEqual([{ folder: 'bbb', detail: "duplicate scheme 'fake' (owned by 'aaa')" }])
  })

  it('isEnabled gates at the plugin-folder level (Settings → Plugins parity)', async () => {
    const root = tmpRoot()

    writeConnectorFolder(root, 'off', `export default { id: 'off-connector', scheme: 'off', connect: async () => ({}) }`)
    writeConnectorFolder(root, 'on', `export default { id: 'on-connector', scheme: 'on', connect: async () => ({}) }`)

    const { connectors, issues } = await loadRemoteConnectors({ root, isEnabled: id => id !== 'off' })

    expect(connectors.map(c => c.id)).toEqual(['on-connector'])
    // Disabled is not an issue — the user chose it.
    expect(issues).toEqual([])
  })

  it('folders without a connector module are invisible to the loader', async () => {
    const root = tmpRoot()

    writeConnectorFolder(root, 'renderer-only', '// no connector here', 'plugin.js')

    const { connectors, issues } = await loadRemoteConnectors({ root })

    expect(connectors).toEqual([])
    expect(issues).toEqual([])
  })

  it('async isEnabled is awaited', async () => {
    const root = tmpRoot()

    writeConnectorFolder(root, 'p', `export default { id: 'p', scheme: 'p', connect: async () => ({}) }`)

    const isEnabled = vi.fn(async () => false)
    const { connectors } = await loadRemoteConnectors({ root, isEnabled })

    expect(connectors).toEqual([])
    expect(isEnabled).toHaveBeenCalledWith('p')
  })
})
