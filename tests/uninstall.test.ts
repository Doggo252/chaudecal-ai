import { describe, expect, it } from 'vitest'
import { uninstallPlan } from '../src/main/uninstall'

describe('uninstall', () => {
  it('removes the app bundle and its data on a Mac, after the app has closed', () => {
    const plan = uninstallPlan({
      platform: 'darwin',
      exePath: '/Applications/Chaude.app/Contents/MacOS/Chaude',
      dataDirs: ['/Users/me/Library/Application Support/Chaude', '/Users/me/Library/Logs/Chaude', '/Users/me'],
      pid: 4242
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.command).toBe('/bin/sh')
    expect(plan.removes).toEqual(['/Applications/Chaude.app', '/Users/me/Library/Application Support/Chaude', '/Users/me/Library/Logs/Chaude'])
    const script = plan.args[1]
    expect(script).toMatch(/^while kill -0 4242/)
    expect(script).toContain(`'/Users/me/Library/Application Support/Chaude'`)
    // A folder that is not plainly the app's own is never removed.
    expect(script).not.toMatch(/'\/Users\/me'( |$)/)
  })

  it('runs the installed uninstaller quietly on Windows, then removes the data', () => {
    const plan = uninstallPlan({
      platform: 'win32',
      exePath: 'C:\\Users\\me\\AppData\\Local\\Programs\\Chaude\\Chaude.exe',
      dataDirs: ['C:\\Users\\me\\AppData\\Roaming\\Chaude', 'C:\\Users\\me'],
      pid: 99
    })
    if ('error' in plan) throw new Error(plan.error)
    expect(plan.command).toBe('powershell.exe')
    const script = plan.args[plan.args.length - 1]
    expect(script).toContain('Wait-Process -Id 99')
    expect(script).toContain(`'C:\\Users\\me\\AppData\\Local\\Programs\\Chaude\\Uninstall Chaude.exe' -ArgumentList '/S'`)
    expect(script).toContain(`Remove-Item -LiteralPath 'C:\\Users\\me\\AppData\\Roaming\\Chaude'`)
    expect(script).not.toContain(`'C:\\Users\\me' `)
  })

  it('declines where it cannot remove the app', () => {
    expect(uninstallPlan({ platform: 'darwin', exePath: '/usr/local/bin/electron', dataDirs: [], pid: 1 })).toHaveProperty('error')
    expect(uninstallPlan({ platform: 'linux', exePath: '/opt/Chaude/chaude', dataDirs: [], pid: 1 })).toHaveProperty('error')
  })
})
