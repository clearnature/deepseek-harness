import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { selectOfficeEngine, writeLinuxEnginePlaceholder } from './libreoffice-packages.mjs'

it.each([
  ['darwin', 'arm64', 'darwin-arm64'], ['darwin', 'x64', 'darwin-x64'],
  ['win32', 'arm64', 'win32-arm64'], ['win32', 'x64', 'win32-x64'],
  ['linux', 'x64', 'wasm'], ['linux', 'arm64', 'wasm'],
  ['darwin', 'other', 'wasm'], ['freebsd', 'x64', 'wasm'],
])('selects the declared engine for %s/%s', (platform, arch, expected) => {
  const optionalDependencies = Object.fromEntries(
    ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'wasm']
      .map(engine => [`@deepseek-ai/libreoffice-kit-${engine}`, '0.0.1']),
  )
  expect(selectOfficeEngine({ optionalDependencies }, { platform, arch })).toBe(expected)
})

it('selects a declared Linux native target without an OS-specific policy change', () => {
  expect(selectOfficeEngine({ optionalDependencies: { '@deepseek-ai/libreoffice-kit-linux-x64': '1' } },
    { platform: 'linux', arch: 'x64' })).toBe('linux-x64')
})

it('uses WASM when no native targets are declared', () => {
  expect(selectOfficeEngine({}, { platform: 'darwin', arch: 'x64' })).toBe('wasm')
})

it('writes a placeholder native Linux engine whose glibc floor routes to WASM', () => {
  const staging = mkdtempSync(join(tmpdir(), 'office-engine-'))
  try {
    writeLinuxEnginePlaceholder(staging, { platform: 'linux', arch: 'x64' })
    const directory = join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit-linux-x64-glibc')
    expect(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')))
      .toEqual({ name: '@deepseek-ai/libreoffice-kit-linux-x64-glibc', version: '0.1.1' })
    expect(JSON.parse(readFileSync(join(directory, 'prebuilds.json'), 'utf8'))).toMatchObject({
      version: '0.1.1',
      schemaVersion: 1,
      status: 'built',
      platform: 'linux-x64-glibc',
      engine: { kind: 'native', glibcMinimum: '99.0' },
    })
    expect(statSync(join(directory, 'bin', 'placeholder')).mode & 0o111).not.toBe(0)
    expect(() => writeLinuxEnginePlaceholder(staging, { platform: 'darwin', arch: 'x64' }))
      .toThrow(/Linux-only/u)
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})

it('carries the placeholder in the office closure so it unpacks beside the kit', async () => {
  const { officePackageDirectories } = await import('./libreoffice-packages.mjs')
  const staging = mkdtempSync(join(tmpdir(), 'office-closure-'))
  try {
    const kit = join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
    const wasm = join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit-wasm')
    mkdirSync(kit, { recursive: true })
    mkdirSync(wasm, { recursive: true })
    writeFileSync(join(kit, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.1.5' }))
    writeFileSync(join(wasm, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-wasm', version: '0.1.5' }))
    writeFileSync(join(wasm, 'prebuilds.json'), '{}')
    writeLinuxEnginePlaceholder(staging, { platform: 'linux', arch: 'x64' })
    const directories = await officePackageDirectories(staging, { platform: 'linux', arch: 'x64' })
    expect(directories).toContain(join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit-linux-x64-glibc'))
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
})
