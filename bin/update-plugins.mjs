#!/usr/bin/env node
/**
 * Align this repo's local plugins with the installed DSH harness.
 *
 * The harness refuses to load a plugin whose `@deepseek-ai/dsh-*` peer
 * dependency does not satisfy the running version (see
 * `evaluatePluginCompatibility` in @deepseek-ai/dsh-app-boot). The plugins in
 * `plugins/` pin those peers exactly, so every harness upgrade needs a version
 * bump in each manifest plus a lockfile refresh.
 *
 * This script derives the target versions from the installed harness itself:
 * the exact `dsh` runtime version for every `@deepseek-ai/dsh-*` package, and
 * the harness's own dependency ranges for cordis and schemastery. It then
 * refreshes pnpm lockfiles and rebuilds only the plugins whose manifests
 * changed, and verifies that every profile still composes.
 *
 * Usage:
 *   bin/update-plugins.mjs                  # update, install, build, verify
 *   bin/update-plugins.mjs --check          # exit 1 if any manifest is stale
 *   bin/update-plugins.mjs --no-install     # edit manifests, skip pnpm install
 *   bin/update-plugins.mjs --no-build       # skip rebuilding changed plugins
 *   bin/update-plugins.mjs --allow-fresh    # ignore pnpm's minimumReleaseAge
 *   bin/update-plugins.mjs --repo <dir>     # operate on another checkout
 *   bin/update-plugins.mjs --dsh-package <package.json>
 *
 * If automatic harness discovery fails, point `--dsh-package` (or
 * `DSH_PACKAGE_JSON`) at the installed `@deepseek-ai/dsh/package.json`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HARNESS = '@deepseek-ai/dsh'
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

class UsageError extends Error {}

function usage() {
  return `Usage: bin/update-plugins.mjs [options]

Update the local plugin manifests to match the installed DSH harness.

Options:
  --check                 Report stale versions and exit 1; change nothing.
  --no-install            Rewrite manifests but skip pnpm install.
  --no-build              Rewrite manifests but skip building changed plugins.
  --allow-fresh           Ignore pnpm's minimumReleaseAge for this install.
                          By default only @deepseek-ai/* is exempted, so a
                          just-published harness can be installed immediately.
  --repo <dir>            Repository root (default: the parent of bin/).
  --dsh-package <path>    Installed @deepseek-ai/dsh package.json or its
                          containing directory. Also DSH_PACKAGE_JSON.
  -h, --help              Show this help.

The script updates every @deepseek-ai/dsh-* dependency in package.json to the
running dsh version, and aligns @deepseek-ai/cordis and
@deepseek-ai/schemastery with the harness's dependency ranges. It then runs
pnpm install for changed plugins, rebuilds them, and composes each profile
with --dump-config to catch remaining compatibility problems.
`
}

function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    dshPackage: undefined,
    check: false,
    install: true,
    build: true,
    allowFresh: false,
    help: false,
  }

  const takeValue = (flag, index) => {
    const value = argv[index]
    if (value === undefined || value.startsWith('-')) throw new UsageError(`${flag} requires a value`)
    return value
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--check') options.check = true
    else if (argument === '--no-install') options.install = false
    else if (argument === '--no-build') options.build = false
    else if (argument === '--allow-fresh') options.allowFresh = true
    else if (argument === '-h' || argument === '--help') options.help = true
    else if (argument === '--repo') options.repo = takeValue(argument, ++index)
    else if (argument.startsWith('--repo=')) options.repo = argument.slice('--repo='.length)
    else if (argument === '--dsh-package') options.dshPackage = takeValue(argument, ++index)
    else if (argument.startsWith('--dsh-package=')) options.dshPackage = argument.slice('--dsh-package='.length)
    else throw new UsageError(`unknown argument ${JSON.stringify(argument)}`)
  }

  return options
}

function run(command, args, { cwd, env, stdio = 'pipe', timeout } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: env ?? process.env,
    encoding: 'utf8',
    stdio,
    timeout,
  })
  if (result.error) throw new Error(`cannot run ${command}: ${result.error.message}`)
  return result
}

function readJson(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${path}: ${error.message}`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`cannot parse ${path}: ${error.message}`)
  }
}

function readVersion(path) {
  try {
    const manifest = readJson(path)
    return typeof manifest.version === 'string' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function warn(message) {
  process.stderr.write(`update-plugins: ${message}\n`)
}

/** Candidate package.json paths for a user-supplied file, directory, or bin path. */
function packageCandidates(candidate) {
  const path = resolve(candidate)
  if (existsSync(path) && statSync(path).isDirectory()) return [join(path, 'package.json')]
  return [path]
}

/** Candidate package.json paths implied by the installed `dsh` executable. */
function harnessCandidatesFromBin(bin) {
  const candidates = []
  let real = bin
  try {
    real = realpathSync(bin)
  } catch {
    // Keep the unresolved path; the file probes below will simply fail.
  }

  const binDir = dirname(real)
  candidates.push(
    join(binDir, 'package.json'),
    join(binDir, '..', 'package.json'),
    join(binDir, '..', 'lib', 'node_modules', HARNESS, 'package.json'),
    join(binDir, '..', '..', 'lib', 'node_modules', HARNESS, 'package.json'),
    join(binDir, 'node_modules', HARNESS, 'package.json'),
  )

  // A Nix wrapper (or another shell shim) carries the real entry point in its
  // text, for example: node --expose-internals /nix/store/.../lib/bin.js "$@"
  try {
    if (statSync(real).size < 2_000_000) {
      const text = readFileSync(real, 'utf8')
      if (!text.includes('\0')) {
        const patterns = [
          /(\/[^\s"'`]*?\/lib\/node_modules\/@deepseek-ai\/dsh\/lib\/bin\.js)/g,
          /(\/[^\s"'`]*?\/@deepseek-ai\/dsh\/lib\/bin\.js)/g,
        ]
        for (const pattern of patterns) {
          for (const match of text.matchAll(pattern)) {
            candidates.push(resolve(dirname(match[1]), '..', 'package.json'))
          }
        }
      }
    }
  } catch {
    // Not a readable text shim; the direct candidates remain.
  }

  return candidates
}

function findHarnessPackage(options) {
  const find = (candidates) => {
    for (const candidate of candidates) {
      let manifest
      try {
        if (!existsSync(candidate)) continue
        manifest = readJson(candidate)
      } catch {
        continue
      }
      if (manifest.name !== HARNESS) continue
      return { path: candidate, dir: dirname(candidate), manifest }
    }
    return undefined
  }

  // An explicit override is authoritative: a typo should fail loudly instead
  // of silently falling back to a different installed harness.
  const overrides = [
    options.dshPackage,
    process.env.DSH_PACKAGE_JSON,
    process.env.DSH_HARNESS_PACKAGE,
  ].filter((value) => typeof value === 'string' && value !== '')
  if (overrides.length > 0) {
    const found = find(overrides.flatMap((value) => packageCandidates(value)))
    if (found) return found
    throw new Error(
      `${overrides.join(', ')} is not an installed ${HARNESS} package.json ` +
        '(expected a package.json or its containing directory)',
    )
  }

  const candidates = []
  const add = (candidate) => {
    if (candidate) candidates.push(...packageCandidates(candidate))
  }

  let bin
  try {
    const probe = run('sh', ['-c', 'command -v dsh'], { cwd: options.repo })
    if (probe.status === 0) bin = probe.stdout.trim().split(/\r?\n/)[0]
  } catch {
    // Reported below if no explicit package path was supplied.
  }
  if (bin) candidates.push(...harnessCandidatesFromBin(bin))

  const found = find(candidates)
  if (found) return found

  // Last resort: the globally installed package, when npm is available.
  try {
    const npmRoot = run('npm', ['root', '-g'], { cwd: options.repo, timeout: 10_000 })
    if (npmRoot.status === 0 && npmRoot.stdout.trim() !== '') {
      add(join(npmRoot.stdout.trim(), HARNESS, 'package.json'))
      const fallback = find(candidates)
      if (fallback) return fallback
    }
  } catch {
    // npm is optional; the error below names the explicit override.
  }

  throw new Error(
    `cannot locate the installed ${HARNESS} package.json; ` +
      'pass --dsh-package <path> or set DSH_PACKAGE_JSON',
  )
}

function readRuntimeVersion(harness) {
  const packageVersion = harness.manifest.version
  if (typeof packageVersion !== 'string' || !VERSION_RE.test(packageVersion)) {
    throw new Error(`${harness.path} has no usable version`)
  }

  try {
    const result = run('dsh', ['--version'])
    const output = result.status === 0 ? result.stdout.trim() : ''
    const match = output.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/)
    if (match) {
      if (match[0] !== packageVersion) {
        warn(
          `dsh --version is ${match[0]} but ${harness.path} says ${packageVersion}; ` +
            'using the running version',
        )
      }
      return match[0]
    }
    warn(`unexpected \`dsh --version\` output ${JSON.stringify(output)}; using ${packageVersion}`)
  } catch (error) {
    warn(`cannot run \`dsh --version\` (${error.message}); using ${packageVersion}`)
  }
  return packageVersion
}

/** Version of a package as installed beside the harness package. */
function installedVersion(harness, name) {
  const direct = join(harness.dir, 'node_modules', ...name.split('/'), 'package.json')
  const version = readVersion(direct)
  if (version) return version
  try {
    const require = createRequire(harness.path)
    return readVersion(require.resolve(`${name}/package.json`))
  } catch {
    return undefined
  }
}

/** The harness's own spec when it has one, else a caret-free `~version`. */
function harnessDependencySpec(harness, name) {
  const declared = harness.manifest.dependencies?.[name]
  if (typeof declared === 'string' && declared.trim() !== '') return declared.trim()
  const version = installedVersion(harness, name)
  if (version) {
    warn(`harness does not declare ${name}; using ~${version}`)
    return `~${version}`
  }
  warn(`cannot determine the harness's ${name} version; leaving existing specs unchanged`)
  return undefined
}

function targetSpec(name, context) {
  if (name === HARNESS || name.startsWith(`${HARNESS}-`)) return context.runtimeVersion
  if (name === '@deepseek-ai/cordis') return context.cordisSpec
  if (name === '@deepseek-ai/schemastery') return context.schemasterySpec
  if (name.startsWith('@deepseek-ai/')) {
    const declared = context.harness.manifest.dependencies?.[name]
    if (typeof declared === 'string' && declared.trim() !== '') return declared.trim()
    const version = installedVersion(context.harness, name)
    if (version) return `~${version}`
  }
  return undefined
}

/** Plan version edits for one plugin manifest without touching the file. */
function planPlugin(pluginDir, context) {
  const packagePath = join(pluginDir, 'package.json')
  const originalText = readFileSync(packagePath, 'utf8')
  const manifest = readJson(packagePath)
  const changes = []

  for (const section of DEP_SECTIONS) {
    const dependencies = manifest[section]
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
      continue
    }
    for (const name of Object.keys(dependencies)) {
      const target = targetSpec(name, context)
      if (target === undefined || dependencies[name] === target) continue
      changes.push({ section, name, from: dependencies[name], to: target })
      dependencies[name] = target
    }
  }

  // An explicit engines.dsh decides alone and makes peerDependencies irrelevant,
  // so keep it aligned too when a plugin uses it.
  if (manifest.engines !== null && typeof manifest.engines === 'object' && !Array.isArray(manifest.engines)) {
    if (Object.hasOwn(manifest.engines, 'dsh')) {
      const current = manifest.engines.dsh
      if (current !== context.runtimeVersion) {
        changes.push({ section: 'engines', name: 'dsh', from: current, to: context.runtimeVersion })
        manifest.engines.dsh = context.runtimeVersion
      }
    }
  }

  return { packagePath, pluginDir, manifest, changes, originalText }
}

function listPlugins(repo) {
  const pluginsDir = join(repo, 'plugins')
  if (!existsSync(pluginsDir)) throw new Error(`${pluginsDir} does not exist`)
  return readdirSync(pluginsDir)
    .map((name) => join(pluginsDir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, 'package.json'))
      } catch {
        return false
      }
    })
    .sort()
}

function installPlugin(plugin, options, repo) {
  const label = relative(repo, plugin.pluginDir)
  // A harness upgrade lands on npm before the local plugins are refreshed. The
  // global pnpm policy here enforces `minimumReleaseAge`, which would reject
  // those exact harness packages as too new. Exempt only the harness scope;
  // --allow-fresh is the explicit "disable the age gate for this install".
  const args = ['install', '--no-frozen-lockfile']
  if (options.allowFresh) args.push('--config.minimumReleaseAge=0')
  else args.push('--config.minimumReleaseAgeExclude=@deepseek-ai/*')
  process.stdout.write(`\n$ pnpm ${args.join(' ')} (${label})\n`)
  const result = run('pnpm', args, {
    cwd: plugin.pluginDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(
      `pnpm install failed in ${plugin.pluginDir}; if pnpm reported ` +
        'ERR_PNPM_NO_MATURE_MATCHING_VERSION, rerun with --allow-fresh',
    )
  }
}

function buildPlugin(plugin, options, repo) {
  const manifest = readJson(plugin.packagePath)
  const script = manifest.scripts?.build
  if (typeof script !== 'string' || script.trim() === '') return
  // pnpm re-verifies dependencies before a script by default. That implicit
  // install does not inherit the release-age exemption above, and would fail
  // against the lockfile we just generated; the explicit install already
  // verified it. Only skip verification when this run actually installed.
  const args = options.install
    ? ['--config.verifyDepsBeforeRun=false', 'run', 'build']
    : ['run', 'build']
  process.stdout.write(`\n$ pnpm ${args.join(' ')} (${relative(repo, plugin.pluginDir)})\n`)
  const result = run('pnpm', args, {
    cwd: plugin.pluginDir,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(
      `build failed in ${plugin.pluginDir}; the version bump is applied, but the plugin ` +
        'source needs adapting to the new harness API',
    )
  }
}

function listProfiles(repo) {
  const profilesDir = join(repo, 'profiles')
  if (!existsSync(profilesDir)) return []
  return readdirSync(profilesDir)
    .map((name) => join(profilesDir, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory() && existsSync(join(path, 'package.json'))
      } catch {
        return false
      }
    })
    .sort()
}

/** Compose every profile and fail on a nonzero exit or a compatibility warning. */
function validateProfiles(repo) {
  const failures = []
  for (const profileDir of listProfiles(repo)) {
    const profile = basename(profileDir)
    const result = run('dsh', ['--profile', profile, '--dump-config'], {
      cwd: repo,
      env: { ...process.env, DSH_HOME: repo },
    })
    const stderr = result.stderr ?? ''
    if (result.status !== 0) {
      failures.push({ profile, detail: stderr || result.stdout })
    } else if (/is incompatible with dsh|incompatible-version/i.test(stderr)) {
      failures.push({ profile, detail: stderr })
    } else {
      process.stdout.write(`ok: profile ${profile} composes\n`)
    }
  }
  return failures
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }

  const repo = resolve(options.repo)
  if (!existsSync(join(repo, 'plugins'))) throw new Error(`${repo} does not look like a DSH home`)

  const harness = findHarnessPackage({ ...options, repo })
  const runtimeVersion = readRuntimeVersion(harness)
  const context = {
    harness,
    runtimeVersion,
    cordisSpec: harnessDependencySpec(harness, '@deepseek-ai/cordis'),
    schemasterySpec: harnessDependencySpec(harness, '@deepseek-ai/schemastery'),
  }

  process.stdout.write(`dsh ${runtimeVersion} (${harness.path})\n`)
  process.stdout.write(
    `cordis ${context.cordisSpec ?? '(unchanged)'}, ` +
      `schemastery ${context.schemasterySpec ?? '(unchanged)'}\n`,
  )

  const plugins = listPlugins(repo).map((pluginDir) => planPlugin(pluginDir, context))
  const changed = plugins.filter((plugin) => plugin.changes.length > 0)
  const totalChanges = changed.reduce((sum, plugin) => sum + plugin.changes.length, 0)

  for (const plugin of plugins) {
    const label = relative(repo, plugin.packagePath)
    if (plugin.changes.length === 0) {
      process.stdout.write(`ok: ${label}\n`)
      continue
    }
    process.stdout.write(`update: ${label}\n`)
    for (const change of plugin.changes) {
      process.stdout.write(
        `  ${change.section}.${change.name}: ${JSON.stringify(change.from)} -> ${JSON.stringify(change.to)}\n`,
      )
    }
  }

  if (options.check) {
    const failures = validateProfiles(repo)
    for (const failure of failures) {
      process.stderr.write(`\nprofile ${failure.profile} failed:\n${failure.detail}\n`)
    }
    if (totalChanges > 0) {
      process.stderr.write(
        `\n${totalChanges} stale version reference(s); run without --check to update.\n`,
      )
      return 1
    }
    if (failures.length > 0) return 1
    process.stdout.write('\nall plugin versions match the installed harness\n')
    return 0
  }

  for (const plugin of changed) {
    writeFileSync(plugin.packagePath, `${JSON.stringify(plugin.manifest, null, 2)}\n`)
  }

  if (changed.length > 0 && options.install) {
    try {
      for (const plugin of changed) installPlugin(plugin, options, repo)
    } catch (error) {
      // Leave the manifests stale so the next run retries the install instead
      // of reporting success against a lockfile that never caught up.
      for (const plugin of changed) writeFileSync(plugin.packagePath, plugin.originalText)
      throw new Error(`${error.message}; manifest changes were rolled back, so rerun the script`)
    }
  } else if (changed.length > 0) {
    process.stdout.write('\nskipped pnpm install; lockfiles may still reference the old versions\n')
  }

  if (changed.length > 0 && options.build) {
    for (const plugin of changed) buildPlugin(plugin, options, repo)
  } else if (changed.length > 0) {
    process.stdout.write('\nskipped builds; run pnpm build in the changed plugins\n')
  }

  const failures = validateProfiles(repo)
  for (const failure of failures) {
    process.stderr.write(`\nprofile ${failure.profile} failed:\n${failure.detail}\n`)
  }
  if (failures.length > 0) return 1

  if (changed.length === 0) {
    process.stdout.write('\nall plugin versions already match the installed harness\n')
  } else {
    process.stdout.write(
      `\nupdated ${changed.length} plugin manifest(s); restart the harness to remount rebuilt plugins\n`,
    )
  }
  return 0
}

try {
  process.exitCode = main()
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`update-plugins: ${error.message}\n\n${usage()}`)
    process.exitCode = 2
  } else {
    process.stderr.write(`update-plugins: ${error.message}\n`)
    process.exitCode = 1
  }
}
