/** Desktop-specific selection of workspace and runtime-only dependency patches. */

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

/** A patch shared with the workspace, excluded from runtime installation, or supplied only to Desktop. */
export type DesktopRuntimePatch =
  | { scope: 'shared'; reason: string }
  | { scope: 'workspace-only'; reason: string }
  | { scope: 'runtime-only'; path: string; reason: string }

/** Every workspace patch requires an explicit Desktop decision; runtime-only entries may add or replace a patch. */
export const DESKTOP_RUNTIME_PATCHES: Readonly<Record<string, DesktopRuntimePatch>> = {
  '@botiverse/oar@0.67.0': { scope: 'workspace-only', reason: 'Patched OAR adapters are embedded in the provider bundle.' },
  '@earendil-works/pi-ai@1.3.0': { scope: 'shared', reason: 'Runtime providers need the streamed argument parsing fix.' },
  '@electron/osx-sign@1.3.3': { scope: 'workspace-only', reason: 'Signing executes on the build host.' },
  '@fortune-sheet/core@1.0.4': { scope: 'workspace-only', reason: 'Patched spreadsheet code is embedded in the client bundle.' },
  '@fortune-sheet/react@1.0.4': { scope: 'workspace-only', reason: 'Patched spreadsheet code is embedded in the client bundle.' },
  '@yao-pkg/pkg@6.21.0': { scope: 'workspace-only', reason: 'The executable packer executes on the build host.' },
  'app-builder-lib@26.17.0': { scope: 'workspace-only', reason: 'DMG format validation executes on the build host.' },
  'exceljs@4.4.0': { scope: 'workspace-only', reason: 'The patched parser is embedded in the client bundle and worker.' },
  'lexical@0.49.0': { scope: 'workspace-only', reason: 'The patched editor is embedded in the client bundle.' },
  'mdast-util-gfm-autolink-literal@2.0.1': { scope: 'workspace-only', reason: 'The patched Markdown parser is embedded in the client bundle.' },
  'micromark-extension-gfm-autolink-literal@2.1.0': { scope: 'workspace-only', reason: 'The patched Markdown parser is embedded in the client bundle.' },
  'node-pty@1.2.0-beta.15': { scope: 'shared', reason: 'Runtime terminals need helper resolution and Windows worker cleanup.' },
}

/** Reviewed Desktop dependency constraints, independent of patch selection. */
export const DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES: Readonly<Record<string, string>> = {
  // The provider declares ^1.3.0; its patch is qualified against 1.3.0.
  '@earendil-works/pi-ai@^1.3.0': '1.3.0',
}

/** Environment variable naming one build's extra dependency constraints, as a JSON object of `name@range` to spec. */
export const DESKTOP_DEPENDENCY_OVERRIDES_ENV = 'DSH_DESKTOP_DEPENDENCY_OVERRIDES'

/**
 * Combine the reviewed constraints with the ones the caller describes for this build.
 *
 * A local prebuild of a registry package cannot live in this repository, because the
 * path belongs to one host. `DSH_DESKTOP_DEPENDENCY_OVERRIDES` supplies it per build as
 * `{"<name>@<range>": "<spec>"}`, so the runtime install resolves that package to the
 * given `file:` tarball instead of the registry. Every entry is validated here, at the
 * earliest point the value exists: a malformed payload, an unknown value type, or a
 * `file:` spec whose absolute path is absent all fail rather than leave pnpm to resolve
 * the registry package or fail later inside its own install.
 * @param environment - Environment carrying the optional JSON object.
 * @returns Dependency overrides for the temporary runtime project.
 * @throws When the variable is set but malformed, or names a missing local file.
 */
export function runtimeDependencyOverrides(environment: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const raw = environment[DESKTOP_DEPENDENCY_OVERRIDES_ENV]?.trim()
  if (raw === undefined || raw === '') return DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch (error) {
    throw new Error(`${DESKTOP_DEPENDENCY_OVERRIDES_ENV} must be a JSON object of "name@range" to spec: ${(error as Error).message}`, { cause: error })
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${DESKTOP_DEPENDENCY_OVERRIDES_ENV} must be a JSON object of "name@range" to spec`)
  }
  const overrides: Record<string, string> = { ...DESKTOP_RUNTIME_DEPENDENCY_OVERRIDES }
  for (const [name, spec] of Object.entries(parsed)) {
    if (name.trim() === '' || typeof spec !== 'string' || spec.trim() === '') {
      throw new Error(`${DESKTOP_DEPENDENCY_OVERRIDES_ENV} entry ${JSON.stringify(name)} must map to a non-empty spec string`)
    }
    const local = /^(?:file|link):/u.exec(spec) === null ? undefined : spec.replace(/^(?:file|link):/u, '')
    if (local !== undefined && isAbsolute(local) && !existsSync(local)) {
      throw new Error(`${DESKTOP_DEPENDENCY_OVERRIDES_ENV} entry ${name} points at a missing path: ${local}`)
    }
    overrides[name] = spec.trim()
  }
  return overrides
}
