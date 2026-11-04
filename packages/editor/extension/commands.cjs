const fs = require('node:fs/promises')
const path = require('node:path')

function createCommands(vscode) {
  function dirtyState() {
    return {
      dirty: vscode.workspace.textDocuments.some(doc => doc.isDirty || doc.isUntitled)
        || vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.isDirty)),
    }
  }

  async function execute(command, root) {
    switch (command.action) {
      case 'dirtyState':
        return dirtyState()
      case 'saveAll': {
        const saved = await vscode.workspace.saveAll(false)
        await vscode.commands.executeCommand('workbench.action.files.saveAll')
        return { saved, ...dirtyState() }
      }
      case 'revertAndClose': {
        const dirtyTabs = vscode.window.tabGroups.all.flatMap(group =>
          group.tabs.filter(tab => tab.isDirty).map(tab => ({ tab, column: group.viewColumn })))
        for (const { tab, column } of dirtyTabs) {
          const input = tab.input
          if (input instanceof vscode.TabInputCustom) {
            await vscode.commands.executeCommand('vscode.openWith', input.uri, input.viewType, { viewColumn: column })
          } else if (input instanceof vscode.TabInputNotebook) {
            await vscode.commands.executeCommand('vscode.openWith', input.uri, input.notebookType, { viewColumn: column })
          } else if (input instanceof vscode.TabInputText) {
            await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(input.uri), { viewColumn: column })
          } else {
            throw new Error('Cannot safely focus dirty editor')
          }
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
        }
        for (const document of vscode.workspace.textDocuments) {
          if (!document.isDirty && !document.isUntitled) continue
          await vscode.window.showTextDocument(document)
          await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor')
        }
        return dirtyState()
      }
      case 'openFile': {
        if (typeof command.path !== 'string') throw new Error('Invalid path')
        const target = await fs.realpath(command.path)
        const relative = path.relative(root, target)
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Path is outside workspace')
        const uri = vscode.Uri.file(target)
        let document
        try {
          document = await vscode.workspace.openTextDocument(uri)
        } catch {
          await vscode.commands.executeCommand('vscode.open', uri)
          return { opened: true }
        }
        const line = Number.isSafeInteger(command.line) && command.line > 0 ? command.line - 1 : 0
        const column = Number.isSafeInteger(command.column) && command.column > 0 ? command.column - 1 : 0
        const position = new vscode.Position(line, column)
        await vscode.window.showTextDocument(document, { selection: new vscode.Range(position, position) })
        return { opened: true }
      }
      case 'appearance': {
        if (typeof command.theme !== 'string') throw new Error('Invalid appearance')
        const config = vscode.workspace.getConfiguration()
        if (config.get?.('workbench.colorTheme') !== command.theme) {
          await config.update('workbench.colorTheme', command.theme, vscode.ConfigurationTarget.Global)
        }
        return { updated: true }
      }
      default:
        throw new Error('Unknown bridge command')
    }
  }

  return { execute }
}

module.exports = { createCommands }
