/**
 * Real Loader composition for package tests. It boots a bundle the way DSH does after `dsh plugin add`: the Loader mounts a
 * `cordis:include` entry whose config file holds the test's own rows, and the bundle's `cordis.patch.yml` is applied to that file
 * as a patch layer. Plugins are imported by package name through Node's real module resolution from the repository root, so a
 * test exercises the package's built `lib/` and its `exports`, exactly as an installed profile does.
 */

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include, { entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { repoRoot } from '../lib/repo.ts'

/** A booted composition; `dispose()` must run after every test that boots one. */
export interface BootedBundle {
  /** Root context that owns the Loader and every loaded plugin. */
  ctx: Context
  /** Dispose the whole composition, waiting for every plugin's disposers, then remove the temporary config directory. */
  dispose(): Promise<void>
}

/** Rows and options of one test composition. */
export interface BootOptions {
  /**
   * YAML entry-list lines for the base config file the bundle patch is applied to, such as the DSH services the bundle's plugins
   * inject. Empty by default.
   */
  rows?: readonly string[]
}

function patchList(value: unknown, file: string): PatchOptions[] {
  if (!Array.isArray(value)) throw new Error(`${file} must be a YAML list of patches`)
  return value.filter((item): item is PatchOptions => typeof item === 'object' && item !== null)
}

/**
 * Boot one bundle package through the real Loader.
 * @param packageDir - repository-relative package directory, such as `packages/example`.
 * @param options - extra base rows for the composition.
 * @returns the booted composition; every plugin entry has finished starting or failed.
 */
export async function bootBundle(packageDir: string, options: BootOptions = {}): Promise<BootedBundle> {
  const directory = resolve(repoRoot, packageDir)
  const manifest: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  const record = typeof manifest === 'object' && manifest !== null ? manifest : {}
  const main = 'main' in record && typeof record.main === 'string' ? record.main : undefined
  if (main === undefined || !existsSync(join(directory, main))) {
    throw new Error(`${packageDir} has no built entry; run \`pnpm run build\` before the Loader tests`)
  }
  const dsh = 'dsh' in record && typeof record.dsh === 'object' && record.dsh !== null ? record.dsh : {}
  const bundle = 'bundle' in dsh && typeof dsh.bundle === 'object' && dsh.bundle !== null ? dsh.bundle : {}
  const patchFile = 'patch' in bundle && typeof bundle.patch === 'string' ? bundle.patch : undefined
  if (patchFile === undefined) throw new Error(`${packageDir}/package.json declares no dsh.bundle.patch`)
  const patches = patchList(load(await readFile(join(directory, patchFile), 'utf8'), { schema: entryListSchema }), patchFile)

  const root = await mkdtemp(join(tmpdir(), 'amadeus-boot-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, options.rows !== undefined && options.rows.length > 0 ? `${options.rows.join('\n')}\n` : '[]\n')

  const ctx = new Context()
  // Bare plugin names resolve from the repository root, whose node_modules links every workspace package.
  ctx.baseUrl = `${pathToFileURL(repoRoot).href}/`
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href, patches } })
    await ctx.loader.await()
    for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  } catch (error) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  return {
    ctx,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    },
  }
}
