// stage-iroh.test.mjs — @number0/iroh staging (entry repair + fail-closed bindings)
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { stageIrohInto } from './stage-native-deps.mjs'

// Minimal magic-byte fixtures for classifyNativeBinary.
const ELF = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(60)])
const MACHO_LE_64 = Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.alloc(60)])

let root
let umbrella
let bindingDir
let dest

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'stage-iroh-'))
  umbrella = join(root, 'node_modules', '@number0', 'iroh')
  bindingDir = join(root, 'node_modules', '@number0', 'iroh-linux-x64-musl')
  dest = join(root, 'out', '@number0', 'iroh')
  mkdirSync(umbrella, { recursive: true })
  mkdirSync(bindingDir, { recursive: true })
  // The published 1.1.0 defect: main points into a directory that doesn't exist.
  writeFileSync(join(umbrella, 'package.json'), JSON.stringify({
    name: '@number0/iroh',
    version: '1.1.0',
    main: 'iroh-js/index.js',
    types: 'iroh-js/index.d.ts'
  }))
  writeFileSync(join(umbrella, 'index.js'), 'module.exports = {}')
  writeFileSync(join(umbrella, 'index.d.ts'), 'export {}')
  writeFileSync(join(bindingDir, 'iroh.linux-x64-musl.node'), ELF)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('stageIrohInto', () => {
  it('repairs the broken entry, stages the JS surface and the binary beside index.js', () => {
    stageIrohInto(umbrella, dest, { platform: 'linux', arch: 'x64', nativeHost: true, bindingDirs: [bindingDir] })
    const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'))
    expect(pkg.main).toBe('./index.js')
    expect(pkg.types).toBe('./index.d.ts')
    expect(existsSync(join(dest, 'index.js'))).toBe(true)
    // Loader candidate #1 is the local filename beside index.js — it must hit.
    expect(existsSync(join(dest, 'iroh.linux-x64-musl.node'))).toBe(true)
    // version metadata survives the rewrite
    expect(pkg.version).toBe('1.1.0')
  })

  it('leaves a valid upstream entry untouched', () => {
    const fixed = join(root, 'fixed-umbrella')
    mkdirSync(fixed, { recursive: true })
    writeFileSync(join(fixed, 'package.json'), JSON.stringify({ name: '@number0/iroh', main: './index.js' }))
    writeFileSync(join(fixed, 'index.js'), 'module.exports = {}')
    const out = join(root, 'out-fixed')
    stageIrohInto(fixed, out, { platform: 'linux', arch: 'x64', nativeHost: false, bindingDirs: [] })
    expect(JSON.parse(readFileSync(join(out, 'package.json'), 'utf8')).main).toBe('./index.js')
  })

  it('refuses a binary compiled for the wrong platform', () => {
    const wrongDir = join(root, 'darwin-binding')
    mkdirSync(wrongDir, { recursive: true })
    writeFileSync(join(wrongDir, 'iroh.darwin-arm64.node'), MACHO_LE_64)
    expect(() =>
      stageIrohInto(umbrella, join(root, 'out-wrong'), {
        platform: 'linux', arch: 'x64', nativeHost: true, bindingDirs: [wrongDir]
      })
    ).toThrow(/wrong platform/)
  })

  it('fails closed on a same-host build with no binding, warns cross-target', () => {
    expect(() =>
      stageIrohInto(umbrella, join(root, 'out-none'), { platform: 'linux', arch: 'x64', nativeHost: true, bindingDirs: [] })
    ).toThrow(/npm install/)
    // Cross-target: nothing the host can add — stage the JS surface, warn, survive.
    const out = join(root, 'out-cross')
    stageIrohInto(umbrella, out, { platform: 'darwin', arch: 'arm64', nativeHost: false, bindingDirs: [] })
    expect(existsSync(join(out, 'index.js'))).toBe(true)
  })
})
