---
description: "Platform version records and local qualification for the Electron updater adapter."
---

# Electron updater compatibility

English | [中文](README.zh.md)

The adapter in `src/updates/electron-updater/` owns library channel policy, cache retirement and Electron HTTP handling. This qualification calls that adapter directly; coordinator, configuration and UI regressions belong to ordinary tests.

Every PR runs a Node-only version check in Windows CI. `verified-versions.json` records the installed Electron, electron-updater and its builder-util-runtime versions separately for Windows and macOS. Missing records, `null` (pending qualification), and version mismatches all fail the check. Git retains prior records. No Electron process or network access is required by this check.

After changing those dependencies, the adapter, or its qualification scripts, run on each affected native platform from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-desktop exec install-electron
pnpm --filter @deepseek-ai/dsh-desktop run test:updates:channels --record
```

Workspace dependencies must already be built (`pnpm run build:artifacts` on a fresh checkout). The final command rebuilds Desktop, runs Electron without opening a window, and records only the current platform after successful exit. Commit the JSON change with the dependency or adapter change. Omit `--record` to test without changing records. The lightweight check compares versions only; unchanged versions do not certify modified adapter code.

The fixture uses a private temporary directory and loopback HTTP feed with inert payloads. It checks channel filenames, downgrade rejection, staging eligibility, downloaded-cache retirement, rejection of obsolete cache by a new updater instance, and macOS proxy closure. It never executes an installer or contacts a production feed. Dependency installation can require external network access. A 30-second watchdog bounds Electron startup, tests and exit; timeout or failure never updates records. Signed installation and application restart remain separate qualification work.

## Recording environment

Each record is taken on native hardware, because the fixture spawns the pinned Electron and reads that platform's own channel filenames. It records the versions `pnpm install` resolved on that machine, and the check compares them with the installed ones, so a range in `package.json` or a stale `node_modules` fails it.

| Requirement | Value |
|---|---|
| Platform | Windows x64 or macOS arm64/x64 — `win-x64`, `mac-arm64` and `mac-x64` are the targets this app packages, so a Windows ARM64 record would describe a build that is never produced |
| OS | A release current enough to run the pinned Electron; Windows CI qualifies on the `windows-2025` runner |
| Node.js | 24.x — `engines.node` requires 24.9.0 or newer, and both CI workflows set `PRIMARY_NODE_VERSION` to 24 |
| pnpm | 12.18.0 from the repository `packageManager` pin, through corepack rather than a global install |
| Electron | The exact version in `apps/desktop/package.json`, downloaded by `exec install-electron` |
| Session | An OS user able to start a graphical application; a Windows service session cannot create the Electron process |
| Network | A package registry for `pnpm install` and the Electron archive for `install-electron`; the qualification itself uses loopback HTTP only |

Recording only builds Desktop and runs the updater fixture. Packaging a release on a newly pinned Electron version additionally needs that platform's `node-addon-require-builtin` prebuild to accept the runtime fingerprint, which this recording does not exercise.
