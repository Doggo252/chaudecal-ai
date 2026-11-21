// Removes the app from this computer. The app cannot delete itself while it runs,
// so it starts a small script that waits for it to close, then removes the app and
// everything it kept on this computer.

import { posix, win32 } from 'node:path'

export interface UninstallInput {
  platform: string
  /** The running program, from app.getPath('exe'). */
  exePath: string
  /** Folders the app keeps its data in. */
  dataDirs: string[]
  /** This process, which the script waits for. */
  pid: number
}

export interface UninstallPlan {
  command: string
  args: string[]
  /** What will be removed, to show the user. */
  removes: string[]
}

/** Quotes a path for a POSIX shell. */
function sh(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
}

/** The script that removes the app, or an explanation of why it cannot. */
export function uninstallPlan(given: UninstallInput): UninstallPlan | { error: string } {
  // Only folders that are plainly the app's own, never a home folder by mistake.
  const { basename, dirname, join } = given.platform === 'win32' ? win32 : posix
  const input = { ...given, dataDirs: [...new Set(given.dataDirs)].filter((d) => /chaude/i.test(basename(d))) }
  if (input.platform === 'darwin') {
    // The program is at Chaude.app/Contents/MacOS/Chaude.
    const bundle = dirname(dirname(dirname(input.exePath)))
    if (!bundle.endsWith('.app')) return { error: 'This copy of Chaude is not an installed app, so it cannot remove itself.' }
    const removes = [bundle, ...input.dataDirs]
    const script = `while kill -0 ${input.pid} 2>/dev/null; do sleep 0.5; done; rm -rf ${removes.map(sh).join(' ')}`
    return { command: '/bin/sh', args: ['-c', script], removes }
  }
  if (input.platform === 'win32') {
    const uninstaller = join(dirname(input.exePath), 'Uninstall Chaude.exe')
    const removes = [dirname(input.exePath), ...input.dataDirs]
    // PowerShell waits for the app to close, runs the installer's own uninstaller
    // quietly (it also removes the shortcuts), then removes the app's data.
    const q = (p: string) => `'${p.replace(/'/g, "''")}'`
    const script = [
      `Wait-Process -Id ${input.pid} -ErrorAction SilentlyContinue`,
      `Start-Sleep -Seconds 1`,
      `if (Test-Path -LiteralPath ${q(uninstaller)}) { Start-Process -FilePath ${q(uninstaller)} -ArgumentList '/S' -Wait }`,
      ...input.dataDirs.map((d) => `Remove-Item -LiteralPath ${q(d)} -Recurse -Force -ErrorAction SilentlyContinue`)
    ].join('; ')
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], removes }
  }
  return { error: 'Removing the app from here works on a Mac and on Windows. Remove it the way you installed it.' }
}
