/**
 * Enforce the package rules of the root `AGENTS.md` on every `packages/<name>/package.json`:
 * - the name is `@amadeus-dsh/<name>`;
 * - `engines.dsh` is the repository's verified DSH range;
 * - every `@deepseek-ai/*` peer dependency is also a dev dependency, and `@deepseek-ai/cordis`, which must share the host's
 *   instance, is never a runtime dependency;
 * - `dsh.bundle.patch` names a patch file that exists and is listed in `files`;
 * - every plugin the patch inserts by package name is the package itself or one of its declared dependencies.
 */

import { existsSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { load } from 'js-yaml'
import { isMain, listRepoFiles, reportGate, repoRoot, type Violation } from './lib/repo.ts'

/** The verified DSH range that every package declares; it changes together with the baseline in the root `AGENTS.md`. */
export const ENGINES_DSH = '>=0.2.1-rc.3 <0.3.0-0'
const SCOPE = '@amadeus-dsh/'
const SHARED_INSTANCE = '@deepseek-ai/cordis'

type Manifest = Record<string, unknown>

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {}
}

/** Package names a patch inserts, from `insert` entries at any nesting depth. */
function insertedNames(patch: unknown): string[] {
  const names: string[] = []
  const visitEntries = (entries: unknown): void => {
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const row = record(entry)
      if (typeof row.name === 'string') names.push(row.name)
      visitEntries(row.children)
      visitEntries(row.insert)
    }
  }
  if (Array.isArray(patch)) for (const item of patch) visitEntries(record(item).insert)
  return names
}

function isPackageSpecifier(name: string): boolean {
  return !name.startsWith('.') && !name.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(name) && !name.startsWith('file:')
}

function packageOf(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0] ?? specifier
}

/**
 * Check one package manifest and its bundle patch.
 * @param directory - repository-relative package directory, `packages/<name>`.
 * @param manifest - parsed `package.json`.
 * @param readPatch - text of a file relative to the package directory, or null when it does not exist.
 * @returns every violated package rule.
 */
export function findPackageMetaViolations(directory: string, manifest: Manifest, readPatch: (file: string) => string | null): Violation[] {
  const file = `${directory}/package.json`
  const violations: Violation[] = []
  const report = (message: string): void => {
    violations.push({ file, line: 1, message })
  }
  const expectedName = `${SCOPE}${directory.slice(directory.lastIndexOf('/') + 1)}`
  if (manifest.name !== expectedName) report(`name must be "${expectedName}"`)
  if (record(manifest.engines).dsh !== ENGINES_DSH) report(`engines.dsh must be "${ENGINES_DSH}"; update the baseline in AGENTS.md and here together`)

  const dependencies = record(manifest.dependencies)
  const peers = record(manifest.peerDependencies)
  const devDependencies = record(manifest.devDependencies)
  for (const peer of Object.keys(peers).filter(name => name.startsWith('@deepseek-ai/'))) {
    if (!(peer in devDependencies)) report(`peer dependency ${peer} must also be a dev dependency for type checking`)
  }
  if (SHARED_INSTANCE in dependencies) report(`${SHARED_INSTANCE} must be a peer and dev dependency, never a runtime dependency`)

  const patchPath = record(record(manifest.dsh).bundle).patch
  if (typeof patchPath !== 'string') {
    report('dsh.bundle.patch must name the bundle patch file')
    return violations
  }
  const normalized = posix.normalize(patchPath)
  const files = Array.isArray(manifest.files) ? manifest.files.filter((entry): entry is string => typeof entry === 'string') : []
  if (!files.some(entry => posix.normalize(entry) === normalized)) report(`files must list the bundle patch "${normalized}"`)
  const patchText = readPatch(normalized)
  if (patchText === null) {
    report(`bundle patch "${normalized}" does not exist`)
    return violations
  }
  let patch: unknown
  try {
    patch = load(patchText)
  } catch (error) {
    report(`bundle patch "${normalized}" is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
    return violations
  }
  const declared = new Set([String(manifest.name), ...Object.keys(dependencies), ...Object.keys(peers)])
  for (const name of insertedNames(patch).filter(isPackageSpecifier)) {
    if (!declared.has(packageOf(name))) report(`bundle patch inserts "${name}", which is neither this package nor a declared dependency`)
  }
  return violations
}

function main(): void {
  const manifests = listRepoFiles(repoRoot, file => /^packages\/[^/]+\/package\.json$/.test(file))
  const violations = manifests.flatMap((manifestFile) => {
    const directory = manifestFile.slice(0, -'/package.json'.length)
    const manifest = record(JSON.parse(readFileSync(resolve(repoRoot, manifestFile), 'utf8')))
    const readPatch = (patch: string): string | null => {
      const path = resolve(repoRoot, directory, patch)
      return existsSync(path) ? readFileSync(path, 'utf8') : null
    }
    return findPackageMetaViolations(directory, manifest, readPatch)
  })
  reportGate('verify-package-meta', manifests.length, violations)
}

if (isMain(import.meta.url)) main()
