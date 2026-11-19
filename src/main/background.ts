// Running in the background: the tray icon, closing to the tray on the hub, and
// starting with the computer. The hub is only useful while the app is running,
// so on the hub machine closing the window should not stop it.

import { app, Menu, nativeImage, Tray } from 'electron'

const TRAY_ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAAFMElEQVRYCeVXW48URRT+qqovMz07u+7O7maHxeA1AouoieIli1xCQOKDISHxTX8ARv+DP4Co8Q8Y8cXwaqLGKBBUYhBjRNigQblMFtgLy9ycvpbn9NCzPbvdyxp5o5Keqj51Lt85der0GeBBHyIrAFpr2WnO75JSvRJG0bgGBKIoizWfJiUJQStD3oqC8IfCwOhJIcQqJasANBqzU6awPoIQe23bBoHJN7KOHTIK13UJiv7W19675XL197RYH4DGwuyUUbC+si17st1up/n+99pxHLieWws63oFyZRmETDSTp6ZQ6uN1GSevhDIgTSt+eE0RS1RlzuwQ62YbWp81E6aeVOP27G7Tsr8LgiDZy5yFYUD7PtqzV9CZv0E8GoXRKpzqJgjThL6HvEHyvufuKQ9XT7ABgt4dUho7+czXAiANE42/ZlD75jja1y8jCvxYmOnOxscwue8wyo9u7tET3emZbYRBuJNoJ5jeOwLyZGythGMjSzO/4M9jR9G8cikOeXIEHH6m8R7zMG/e6NrQY8l+CkBCWj0LulJefRHXvjiGyHMzDbBR3mMe5mWZ9Yx1cXGS3f7tJ7gLN+Pky1PMfMzDvHFi5jGm6OsCwGFrXf0DkkKtSLiXuSlFgpKRqhV5DjSJd63jTIktJ2GauHJtk9bId7FEHvr0lHSEwTCM2aK7xa0DB74uQOo23RIXhtTopuhKbf3vvVvQT+6+cRVT9Hz590V8Sm5fntgQA3AIwJNU3Q60bmOoM46L4QuY05MEwIaMPIzflHDPNzG1uRhHYq1imguAw8zP0XMncWzmHH0KQghKNKa5QuF0qYBa+BK2Np9HxIbBEaGyLU3Umg4+O76I6RdLOLhviOj5IzcHLAr155d+xScXzsKUCgWqekopAkBnTWGvdCqoLu5AXVik3e+eP+WAVBKmpYgXOPVjE2fOtmAaDDt7ZALgZJv/p0We/xwbT8SV7VCSkWaKafXOFpiRRXAiighzEDDaU3YxtsQUQwmcPtNEvUnRS5SswJEJwKA7fGHxJmZbdUqmZRa+28opwVYPoeyOQgtSTAoD0i5MG0ax1Hf/WXTpToDarE8RyUawrD2FjCNwq91EmJU9tGerQShN3rNOetcMwLLjdUpNvOQ2ol7/jxFguyU682zMQCQCMsp9QpcjxrHScvJOm7ZNP8yeMTIjENA1e2p4DINWgTK8X1KQ257ZQcdugte8qyjWHLWVg0WLBYnqhIkw6teT8GYCoDYMjwyOYO/DT6ATri4nkQwxP3w1BsCKinevZ6I0mT1fY9uWIsYq9J1Y1Yx1uTIB8BZ7/s4z09g+ugHtwOsrrTJSmBu6jtrQZVjahCWoR0is0syeu57Gpo0W9u8Z7JNNscXLXAAhHcMoZfUHu97AocefBteFThigQz2AR2V4pODg0OsjOHxwFAMDkvoIDfbYp8ege7/jOQdvvVlBeUDles8IUpVQzHHpTQ+fql+lUML7L7+Gt7cuYIauZsOnUkvAtlWqmBgoU0KGeHa7g2s1D/VGiAKd+SSd+fgYdUcUijBMx4YvCtsQc4mdnsV7tWRcDwz+1JECVszgkgSVpEXSPU/ws9G8M1/ZkvUAkFKz1Zj72ik6u+93R5x4y51xu9U+URoa20+RiLO7lwNM0EId4daZGe/3SNpyrdSRxDjb6EUgMbi4eGObY5kfUjzv+x+Ttue/NzIycT6xlQmAiXQc/NfsVaou03Tc1KwS0LxDTWtLrylnyDtNReoWfcq/p79mp8jznGqQFnzQ1v8CPh0Q2PBAxMIAAAAASUVORK5CYII='

/** True when closing the window should hide it and leave the app running. */
export function hidesOnClose(input: { platform: string; hosting: boolean; keepRunning: boolean; quitting: boolean }): boolean {
  if (input.quitting) return false
  // macOS already keeps an app alive after its last window closes.
  if (input.platform === 'darwin') return false
  return input.hosting && input.keepRunning
}

/** True when the app was started by the system at sign-in and should stay out of the way. */
export function startedHidden(argv: string[], openedAtLogin: boolean): boolean {
  return openedAtLogin || argv.includes('--hidden')
}

let tray: Tray | undefined

export function showTray(actions: { open(): void; quit(): void; status(): string }): void {
  // The Dock does this job on macOS.
  if (process.platform === 'darwin' || tray) return
  try {
    tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON).resize({ width: 16, height: 16 }))
  } catch {
    // No tray on this system (some Linux desktops). The window still works.
    return
  }
  tray.setToolTip('Chaude')
  const rebuild = () =>
    tray?.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Chaude', click: actions.open },
        { label: actions.status(), enabled: false },
        { type: 'separator' },
        { label: 'Quit', click: actions.quit }
      ])
    )
  rebuild()
  tray.on('click', actions.open)
  tray.on('right-click', rebuild)
}

export function applyStartAtLogin(enabled: boolean): void {
  // Only an installed app can register itself. A development run would register the bare Electron binary.
  if (!app.isPackaged) return
  app.setLoginItemSettings({ openAtLogin: enabled, args: ['--hidden'] })
}
