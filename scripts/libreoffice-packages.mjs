/** Locate the complete installed Office package closure used by standalone CLI processes. */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'

/**
 * Require the declared native engine, or use WASM on other targets.
 * @param {{ optionalDependencies?: Record<string, string> }} manifest - Installed kit manifest.
 * @param {{ platform: string, arch: string }} target - Distribution platform and CPU.
 * @returns {string} Engine package suffix.
 */
export function selectOfficeEngine(manifest, target) {
  const native = `${target.platform}-${target.arch}`
  return Object.hasOwn(manifest.optionalDependencies ?? {}, `@deepseek-ai/libreoffice-kit-${native}`) ? native : 'wasm'
}

/**
 * Find every required package, retaining its installed dependency resolution and target engine.
 * @param {string} staging - Symlink-free installed Node project.
 * @param {{ platform: string, arch: string }} target - Distribution platform and CPU.
 * @returns {Promise<string[]>} Absolute package directories; rejects missing dependencies and paths outside staging.
 */
export async function officePackageDirectories(staging, target) {
  const entry = join(staging, 'node_modules', '@deepseek-ai', 'libreoffice-kit')
  const manifest = JSON.parse(await readFile(join(entry, 'package.json'), 'utf8'))
  const engineName = `@deepseek-ai/libreoffice-kit-${selectOfficeEngine(manifest, target)}`
  const packages = new Set()

  /** @param {string} packageDirectory - Installed package directory. */
  async function visit(packageDirectory) {
    if (packages.has(packageDirectory)) return
    const relativeDirectory = relative(staging, packageDirectory)
    if (isAbsolute(relativeDirectory) || relativeDirectory === '..' || relativeDirectory.startsWith(`..${sep}`)) {
      throw new Error(`Office dependency is outside the deployed closure: ${packageDirectory}`)
    }
    const manifestPath = join(packageDirectory, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    packages.add(packageDirectory)
    const require = createRequire(manifestPath)
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ])
    for (const name of dependencies) {
      if (name.startsWith('@deepseek-ai/libreoffice-kit-')) continue
      const optional = manifest.optionalDependencies?.[name] !== undefined
        || manifest.peerDependenciesMeta?.[name]?.optional === true
      const dependencyDirectory = (require.resolve.paths(name) ?? [])
        .map(directory => join(directory, name))
        .find(directory => existsSync(directory))
      if (dependencyDirectory === undefined) {
        if (optional) continue
        throw new Error(`Office dependency ${name} required by ${manifest.name} is missing.`)
      }
      if (optional) {
        const dependency = JSON.parse(await readFile(join(dependencyDirectory, 'package.json'), 'utf8'))
        if (!supports(dependency.os, target.platform) || !supports(dependency.cpu, target.arch)) continue
      }
      await visit(dependencyDirectory)
    }
  }

  await visit(entry)
  const engineDirectory = join(staging, 'node_modules', engineName)
  if (!existsSync(engineDirectory)) throw new Error(`Office engine ${engineName} required for ${target.platform}/${target.arch} is missing.`)
  await visit(engineDirectory)
  const placeholderDirectory = join(staging, 'node_modules', `@deepseek-ai/libreoffice-kit-linux-${target.arch}-glibc`)
  if (target.platform === 'linux' && existsSync(placeholderDirectory)) await visit(placeholderDirectory)
  return [...packages].sort()
}

/**
 * Write the placeholder native Linux engine that routes the kit to its WASM engine.
 *
 * The kit resolves its native engine first and probes installed packages with
 * `lstatSync(..., { throwIfNoEntry: false })`, which reports a missing package as present inside an
 * ASAR archive, so the documented WASM fallback becomes unreachable in packaged applications.
 * The placeholder declares a glibc floor above every real host, and the kit's own compatibility
 * gate then selects the WASM engine. The kit reads only its manifest; nothing executes it.
 *
 * @param {string} staging - Symlink-free installed Node project.
 * @param {{ platform: string, arch: string }} target - Distribution platform and CPU.
 * @returns {void}
 */
export function writeLinuxEnginePlaceholder(staging, target) {
  if (target.platform !== 'linux') throw new Error(`Office engine placeholder is Linux-only; got ${target.platform}`)
  const suffix = `linux-${target.arch}-glibc`
  const name = `@deepseek-ai/libreoffice-kit-${suffix}`
  const directory = join(staging, 'node_modules', '@deepseek-ai', `libreoffice-kit-${suffix}`)
  mkdirSync(join(directory, 'bin'), { recursive: true })
  mkdirSync(join(directory, 'program'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name, version: '0.1.1' }, null, 2)}\n`)
  writeFileSync(join(directory, 'prebuilds.json'), `${JSON.stringify({
    version: '0.1.1',
    schemaVersion: 1,
    status: 'built',
    platform: suffix,
    engine: { kind: 'native', glibcMinimum: '99.0', executable: 'bin/placeholder', programDirectory: 'program' },
  }, null, 2)}\n`)
  writeFileSync(join(directory, 'bin', 'placeholder'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(directory, 'bin', 'placeholder'), 0o755)
  writeFileSync(join(directory, 'program', 'placeholder'), 'The glibc floor routes every host to the WASM engine.\n')
}

/**
 * @param {string[] | undefined} values - npm platform or CPU selectors.
 * @param {string} value - Target platform or CPU.
 * @returns {boolean} Whether the optional package supports the target.
 */
function supports(values, value) {
  return values === undefined || (!values.includes(`!${value}`)
    && (values.every(item => item.startsWith('!')) || values.includes(value) || values.includes('any')))
}
