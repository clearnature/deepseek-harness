/** The Git transport an installation of a self-hosted repository uses, chosen by probing access before pnpm starts. */
import { execa } from 'execa'
import hostedGitInfo from 'hosted-git-info'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { ParsedInstallSpec } from './install-spec.ts'

/** Deadline and cancellation for each read-only access probe. */
export interface GitTransportOptions {
  timeoutMs: number
  signal: AbortSignal
  /** The application-owned package manager's environment, also used by its Git children. */
  env?: Readonly<Record<string, string>>
}

/** An HTTP(S) Git URL with an optional `git+` prefix, which pnpm clones over that transport as written. */
const HTTP_GIT_URL = /^(?:git\+)?https?:\/\//i
/** An SSH Git URL with an optional `git+` prefix, which pnpm records as HTTPS. */
const SSH_GIT_URL = /^(?:git\+)?ssh:\/\//i

/**
 * The HTTPS address pnpm records for a Git spec: an HTTP(S) URL as written, the HTTPS form of an SSH URL, or the
 * HTTPS form of a hosted shorthand such as `github:owner/repo`.
 * @param spec The parsed installation address.
 * @returns The HTTPS URL, or `undefined` for a spec without one, or whose URL carries credentials or a query.
 */
function httpsForm(spec: ParsedInstallSpec): URL | undefined {
  if (spec.kind !== 'git') return undefined
  const hosted = hostedGitInfo.fromUrl(spec.spec)
  const hostedHttps = hosted === undefined ? undefined : hosted.https({ noGitPlus: true, noCommittish: true })
  const raw = hostedHttps
    ?? (HTTP_GIT_URL.test(spec.spec) ? spec.spec.replace(/^git\+/i, '') : undefined)
    ?? (SSH_GIT_URL.test(spec.spec) ? spec.spec.replace(/^git\+/i, '').replace(/^ssh:\/\/git@/i, 'https://') : undefined)
  if (raw === undefined) return undefined
  const url = new URL(raw)
  if (url.username !== '' || url.password !== '' || url.search !== '') return undefined
  return url
}

/**
 * The SSH form of a Git spec, whatever its host and however it is written.
 * @param spec The parsed installation address.
 * @returns `git+ssh://git@<host>/<path>` with the spec's fragment, or `undefined` for a spec without an HTTPS form.
 */
function sshForm(spec: ParsedInstallSpec): string | undefined {
  const url = httpsForm(spec)
  if (url === undefined) return undefined
  // The fragment is copied as written: WHATWG serialization would percent-encode some of its characters.
  const hash = /#.*$/s.exec(spec.spec)?.[0] ?? ''
  return `git+ssh://git@${url.hostname}${url.pathname}${hash}`
}

/**
 * The SSH form of an HTTP(S) Git spec on a host pnpm has no transport fallback for. pnpm tries HTTPS and SSH itself
 * for the hosts `hosted-git-info` knows, such as GitHub and GitLab.com, and clones any other URL over the transport
 * it names.
 * @param spec The parsed installation address.
 * @returns `git+ssh://git@<host>/<path>` on SSH's default port with the spec's fragment, or `undefined` for a spec that
 * is not an HTTP(S) Git URL on such a host, or whose URL carries credentials or a query.
 */
export function sshGitSpec(spec: ParsedInstallSpec): string | undefined {
  if (spec.kind !== 'git' || !HTTP_GIT_URL.test(spec.spec) || hostedGitInfo.fromUrl(spec.spec) !== undefined) return undefined
  return sshForm(spec)
}

/**
 * Git configuration that makes one pnpm run clone an HTTPS-recorded Git spec over SSH.
 *
 * pnpm 12 resolves every Git spec over HTTPS and records that URL, because it has to work on every machine that
 * installs the lockfile, and it no longer retries SSH after HTTPS fails. A repository only SSH can read therefore
 * needs this rewrite on the install run itself: Git applies it while pnpm resolves, and the recorded URL stays HTTPS.
 * Git applies one rewrite per URL, so the mapping names the exact address pnpm resolves, with or without `.git`.
 * @param spec The parsed installation address.
 * @returns Environment entries for one pnpm run, or `undefined` for a spec without an HTTPS form.
 */
export function sshTransportEnv(spec: ParsedInstallSpec): Readonly<Record<string, string>> | undefined {
  const https = httpsForm(spec)
  const ssh = sshForm(spec)
  if (https === undefined || ssh === undefined) return undefined
  const recorded = https.href
  const prefixes = recorded.endsWith('.git') ? [recorded, recorded.slice(0, -'.git'.length)] : [recorded]
  const env: Record<string, string> = { GIT_CONFIG_COUNT: String(prefixes.length) }
  const target = ssh.replace(/^git\+/u, '')
  prefixes.forEach((prefix, index) => {
    env[`GIT_CONFIG_KEY_${String(index)}`] = `url.${target}.insteadOf`
    env[`GIT_CONFIG_VALUE_${String(index)}`] = prefix
  })
  return env
}

/**
 * Probe whether Git can read a repository with the installer's Git configuration and credential helpers. Git's
 * terminal and askpass prompts are disabled, `core.askPass` included because Windows drops the empty `GIT_ASKPASS`,
 * and on POSIX the probe has no controlling terminal, so SSH cannot ask about host keys or passphrases either.
 * @param repository The repository URL Git reads.
 * @param dir The profile directory where installation runs.
 * @param options The probe deadline, cancellation and environment.
 * @returns Whether `git ls-remote` listed the repository's HEAD.
 */
async function readable(repository: string, dir: string, options: GitTransportOptions): Promise<boolean> {
  const result = await execa('git', ['-c', 'core.askPass=', 'ls-remote', '--exit-code', '--', repository, 'HEAD'], {
    cwd: dir,
    env: {
      ...scrubbedParentEnv(), ...options.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '', SSH_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never',
    },
    extendEnv: false, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', reject: false,
    timeout: options.timeoutMs, cancelSignal: options.signal, killDescendants: true, killSignal: 'SIGKILL',
  })
  return !result.failed
}

/**
 * Probe the SSH form of a Git spec after pnpm could not resolve it, and produce the run-scoped rewrite that sends an
 * HTTPS-recorded repository over SSH without changing the URL pnpm records.
 * @param spec The parsed installation address.
 * @param dir The profile directory where installation runs.
 * @param options The probe deadline, cancellation and the installer's environment.
 * @returns Environment entries for one install run, or `undefined` when the spec has no SSH form or SSH cannot read it.
 */
export async function chooseSshTransport(
  spec: ParsedInstallSpec, dir: string, options: GitTransportOptions,
): Promise<Readonly<Record<string, string>> | undefined> {
  const ssh = sshForm(spec)
  if (ssh === undefined || options.signal.aborted) return undefined
  if (!await readable(ssh.replace(/^git\+/i, '').replace(/#.*$/s, ''), dir, options)) return undefined
  return sshTransportEnv(spec)
}

/**
 * Choose how pnpm clones an HTTP(S) Git repository that {@link sshGitSpec} has an SSH form for: probe the spec's URL,
 * and when HTTP(S) cannot read it, probe the SSH form.
 * @param spec The parsed installation address.
 * @param dir The profile directory where installation runs.
 * @param options The deadline of each probe, cancellation and the installer's environment.
 * @returns The SSH form when only SSH can read the repository; otherwise the spec unchanged.
 */
export async function chooseGitTransport(spec: ParsedInstallSpec, dir: string, options: GitTransportOptions): Promise<string> {
  const ssh = sshGitSpec(spec)
  if (ssh === undefined) return spec.spec
  const strip = (value: string): string => value.replace(/^git\+/i, '').replace(/#.*$/s, '')
  if (await readable(strip(spec.spec), dir, options)) return spec.spec
  if (options.signal.aborted || !await readable(strip(ssh), dir, options)) return spec.spec
  return ssh
}
