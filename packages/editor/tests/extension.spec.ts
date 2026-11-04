import { createRequire } from 'node:module'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

interface Commands {
  execute(command: { action: string; [key: string]: string | number }, root: string): Promise<unknown>
}

const require = createRequire(import.meta.url)
const loaded: unknown = require('../extension/commands.cjs')
if (typeof loaded !== 'object' || loaded === null || !('createCommands' in loaded) || typeof loaded.createCommands !== 'function') {
  throw new Error('Bridge commands are unavailable')
}
const createCommands = loaded.createCommands as (vscode: object) => Commands

it('treats untitled documents and dirty custom tabs as unsaved', async () => {
  const documents = [{ isDirty: false, isUntitled: true }]
  const tabs = [{ isDirty: true }]
  const commands = createCommands({
    workspace: { textDocuments: documents },
    window: { tabGroups: { all: [{ tabs }] } },
  })
  expect(await commands.execute({ action: 'dirtyState' }, '/')).toEqual({ dirty: true })
  documents[0]!.isUntitled = false
  expect(await commands.execute({ action: 'dirtyState' }, '/')).toEqual({ dirty: true })
  tabs[0]!.isDirty = false
  expect(await commands.execute({ action: 'dirtyState' }, '/')).toEqual({ dirty: false })
})

it('updates only the user theme, preserves font settings and opens a file within the workspace', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'editor-extension-'))
  try {
    const file = path.join(root, 'file.txt')
    await writeFile(file, 'text')
    const current = new Map<string, string | number>()
    current.set('editor.fontSize', 19)
    current.set('terminal.integrated.fontSize', 17)
    const update = vi.fn(async (key: string, value: string | number) => { current.set(key, value) })
    const showTextDocument = vi.fn(async () => {})
    class Position { constructor(public line: number, public column: number) {} }
    class Range { constructor(public start: Position, public end: Position) {} }
    const commands = createCommands({
      workspace: {
        getConfiguration: () => ({ get: (key: string) => current.get(key), update }),
        openTextDocument: async () => ({ uri: file }),
      },
      window: { showTextDocument },
      Uri: { file: (value: string) => value },
      Position, Range, ConfigurationTarget: { Global: 1 },
    })
    await commands.execute({ action: 'appearance', theme: 'Default Dark Modern' }, root)
    expect(update).toHaveBeenCalledOnce()
    expect(update).toHaveBeenCalledWith('workbench.colorTheme', 'Default Dark Modern', 1)
    expect(current.get('editor.fontSize')).toBe(19)
    expect(current.get('terminal.integrated.fontSize')).toBe(17)
    await commands.execute({ action: 'appearance', theme: 'Default Dark Modern' }, root)
    expect(update).toHaveBeenCalledOnce()
    await commands.execute({ action: 'openFile', path: file, line: 3, column: 2 }, root)
    expect(showTextDocument).toHaveBeenCalled()
    await expect(commands.execute({ action: 'openFile', path: os.tmpdir() }, root)).rejects.toThrow('outside')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reverts a dirty text document and checks the resulting state', async () => {
  const document = { isDirty: true, isUntitled: false }
  const executeCommand = vi.fn(async () => { document.isDirty = false })
  const commands = createCommands({
    workspace: { textDocuments: [document] },
    window: { tabGroups: { all: [] }, showTextDocument: async () => {} },
    commands: { executeCommand },
  })
  expect(await commands.execute({ action: 'revertAndClose' }, '/')).toEqual({ dirty: false })
  expect(executeCommand).toHaveBeenCalledWith('workbench.action.revertAndCloseActiveEditor')
})

it('reports save failure even if the dirty state subsequently clears', async () => {
  const executeCommand = vi.fn(async () => {})
  const commands = createCommands({
    workspace: { textDocuments: [], saveAll: async () => false },
    window: { tabGroups: { all: [] } },
    commands: { executeCommand },
  })
  expect(await commands.execute({ action: 'saveAll' }, '/')).toEqual({ saved: false, dirty: false })
  expect(executeCommand).toHaveBeenCalledWith('workbench.action.files.saveAll')
})
