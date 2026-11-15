import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { prepareRuntimePatches } from '../scripts/prepare-runtime-patches.ts'
import {
  DESKTOP_DEPENDENCY_OVERRIDES_ENV, DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES, runtimeDependencyOverrides,
} from '../scripts/runtime-patch-policy.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-override-policy-'))
  roots.push(root)
  return root
}

describe('runtimeDependencyOverrides', () => {
  it('returns the reviewed constraints when the variable is unset or blank', () => {
    expect(runtimeDependencyOverrides({})).toEqual(DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES)
    expect(runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: '   ' })).toEqual(DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES)
  })

  it('merges a build-specific constraint over the reviewed ones', () => {
    const overrides = runtimeDependencyOverrides({
      [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: JSON.stringify({ 'fixture-linux-x64-gnu@0.1.9': 'file:relative.tgz' }),
    })
    expect(overrides).toEqual({
      ...DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES,
      'fixture-linux-x64-gnu@0.1.9': 'file:relative.tgz',
    })
  })

  it('rejects a malformed object instead of falling back to the registry package', () => {
    expect(() => runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: '{' })).toThrow(/must be a JSON object/u)
    expect(() => runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: '["a@1"]' })).toThrow(/must be a JSON object/u)
    expect(() => runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: 'null' })).toThrow(/must be a JSON object/u)
  })

  it('names the entry whose spec is not a non-empty string', () => {
    for (const payload of [{ 'a@1.0.0': 3 }, { 'a@1.0.0': '  ' }, { '  ': '1.0.0' }]) {
      expect(() => runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: JSON.stringify(payload) }))
        .toThrow(/non-empty spec string/u)
    }
  })

  it('rejects a local tarball that does not exist but accepts one that does', () => {
    const root = scratch()
    const missing = join(root, 'absent.tgz')
    expect(() => runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: JSON.stringify({ 'a@1.0.0': `file:${missing}` }) }))
      .toThrow(/points at a missing path/u)
    const present = join(root, 'present.tgz')
    writeFileSync(present, '')
    expect(runtimeDependencyOverrides({ [DESKTOP_DEPENDENCY_OVERRIDES_ENV]: JSON.stringify({ 'a@1.0.0': `file:${present}` }) })['a@1.0.0'])
      .toBe(`file:${present}`)
  })

  it('reaches the temporary runtime project that prepareRuntimePatches writes', () => {
    const project = scratch()
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, 'pnpm-workspace.yaml'), yaml.dump({ packages: ['.'], nodeLinker: 'hoisted' }))
    const tarball = join(scratch(), 'fixture.tgz')
    writeFileSync(tarball, '')
    // The production call passes only two arguments, so this exercises the default parameter
    // that reads the environment rather than a value passed by the test.
    const saved = { ...process.env }
    process.env[DESKTOP_DEPENDENCY_OVERRIDES_ENV] = JSON.stringify({ 'fixture-linux-x64-gnu@0.1.9': `file:${tarball}` })
    try {
      prepareRuntimePatches(project, resolve(import.meta.dirname, '../../..'))
    } finally {
      process.env = saved
    }
    const written = yaml.load(readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')) as { overrides: Record<string, string> }
    expect(written.overrides['fixture-linux-x64-gnu@0.1.9']).toBe(`file:${tarball}`)
    expect(written.overrides['@earendil-works/pi-ai@^1.3.0']).toBe('1.3.0')
  })
})
