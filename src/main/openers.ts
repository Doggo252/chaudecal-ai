// Opens a code chat's folder, or a file in it, in the user's own tools: their
// code editor, Finder or Explorer, or a terminal.

import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { OpenHow } from '@shared/ipc'
import { cliEnv, findBinary } from './env'

/** The command line launchers of common editors, in the order tried. */
const EDITORS = ['cursor', 'code', 'windsurf', 'zed', 'subl']

/** Mac app bundles to try when no launcher is on the PATH. */
const MAC_EDITORS = ['Cursor', 'Visual Studio Code', 'Windsurf', 'Zed', 'Sublime Text']

function detached(cmd: string, args: string[], cwd?: string): Promise<boolean> {
  return new Promise((done) => {
    try {
      // A .cmd launcher on Windows runs only through the command prompt.
      const viaCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)
      const child = spawn(viaCmd ? 'cmd.exe' : cmd, viaCmd ? ['/c', cmd, ...args] : args, { cwd, env: cliEnv(), detached: true, stdio: 'ignore', windowsHide: viaCmd })
      child.once('error', () => done(false))
      child.once('spawn', () => {
        child.unref()
        done(true)
      })
    } catch {
      done(false)
    }
  })
}

/** A path from a step, which may be relative to the folder. Undefined when it does not exist. */
export function pathIn(folder: string, file?: string): string | undefined {
  const target = !file ? folder : isAbsolute(file) ? file : resolve(join(folder, file))
  return existsSync(target) ? target : undefined
}

async function openEditor(folder: string, target: string): Promise<void> {
  for (const name of EDITORS) {
    const bin = findBinary(name, '')
    // The folder opens as the window's project, with the file in front.
    if (bin && (await detached(bin, target === folder ? [folder] : [folder, target]))) return
  }
  if (process.platform === 'darwin') {
    for (const appName of MAC_EDITORS) {
      if (existsSync(`/Applications/${appName}.app`) && (await detached('open', ['-a', appName, target]))) return
    }
  }
  const failed = await shell.openPath(target)
  if (failed) throw new Error(failed)
}

async function openTerminal(folder: string): Promise<void> {
  if (process.platform === 'darwin') {
    const app = existsSync('/Applications/iTerm.app') ? 'iTerm' : 'Terminal'
    if (await detached('open', ['-a', app, folder])) return
  } else if (process.platform === 'win32') {
    if (findBinary('wt', '') && (await detached('wt', ['-d', folder]))) return
    // Started on its own, the command prompt gets a window of its own.
    if (await detached('cmd.exe', ['/K'], folder)) return
  } else {
    for (const term of ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']) {
      if (findBinary(term, '') && (await detached(term, [], folder))) return
    }
  }
  throw new Error('No terminal app was found.')
}

export async function openInTool(folder: string, how: OpenHow, file?: string): Promise<void> {
  if (!folder || !existsSync(folder)) throw new Error('This chat has no folder on this computer yet.')
  const target = pathIn(folder, file)
  if (!target) throw new Error(`${file} is not there any more.`)
  if (how === 'editor') return openEditor(folder, target)
  if (how === 'terminal') return openTerminal(statSync(target).isDirectory() ? target : folder)
  if (target === folder) {
    const failed = await shell.openPath(folder)
    if (failed) throw new Error(failed)
  } else shell.showItemInFolder(target)
}
