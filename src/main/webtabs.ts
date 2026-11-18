// Embedded claude.ai and chatgpt.com. These are the real sites, so everything
// they offer (cloud chats, projects, images, voice, account settings) is
// available without leaving the app. Each keeps its own sign-in, stored on this
// machine only. The user signs in themselves. This app never sees credentials.

import { BrowserWindow, WebContentsView, session, shell } from 'electron'
import type { WebService, WebState } from '@shared/ipc'

interface ServiceInfo {
  home: string
  /** Hosts that count as the service itself. */
  hosts: string[]
}

export const SERVICES: Record<WebService, ServiceInfo> = {
  claude: { home: 'https://claude.ai/new', hosts: ['claude.ai', 'claude.com', 'anthropic.com'] },
  chatgpt: { home: 'https://chatgpt.com/', hosts: ['chatgpt.com', 'openai.com'] }
}

/** Sign-in providers that may open in a popup. */
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com', 'auth0.com', 'auth.openai.com']

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`))
}

export function belongsTo(service: WebService, url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && hostMatches(u.hostname, SERVICES[service].hosts)
  } catch {
    return false
  }
}

export class WebTabs {
  private views = new Map<WebService, WebContentsView>()
  private shown?: WebService

  constructor(
    private window: () => BrowserWindow | undefined,
    private onState: (state: WebState) => void
  ) {}

  private state(service: WebService): WebState {
    const wc = this.views.get(service)!.webContents
    return {
      service,
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading()
    }
  }

  private ensure(service: WebService): WebContentsView {
    const existing = this.views.get(service)
    if (existing) return existing
    const partition = `persist:web-${service}`
    const ses = session.fromPartition(partition)
    ses.setPermissionRequestHandler((wc, permission, callback) => {
      const fromService = belongsTo(service, wc.getURL())
      // Microphone for voice, clipboard for copy buttons, fullscreen for media.
      const allowed = ['media', 'clipboard-sanitized-write', 'fullscreen', 'notifications']
      callback(fromService && allowed.includes(permission))
    })
    const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } })
    const wc = view.webContents
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const host = new URL(url).hostname
        if (hostMatches(host, SERVICES[service].hosts) || hostMatches(host, AUTH_HOSTS)) {
          return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } } }
        }
        if (/^https?:$/.test(new URL(url).protocol)) void shell.openExternal(url)
      } catch {
        // Not a URL this app will open.
      }
      return { action: 'deny' }
    })
    const push = () => {
      if (!wc.isDestroyed()) this.onState(this.state(service))
    }
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('page-title-updated', push)
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    this.views.set(service, view)
    void wc.loadURL(SERVICES[service].home)
    return view
  }

  show(service: WebService, bounds: { x: number; y: number; width: number; height: number }): void {
    const win = this.window()
    if (!win) return
    const view = this.ensure(service)
    if (this.shown && this.shown !== service) win.contentView.removeChildView(this.views.get(this.shown)!)
    if (this.shown !== service) win.contentView.addChildView(view)
    this.shown = service
    view.setBounds({ x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)) })
    this.onState(this.state(service))
  }

  hide(): void {
    const win = this.window()
    if (win && this.shown) win.contentView.removeChildView(this.views.get(this.shown)!)
    this.shown = undefined
  }

  navigate(service: WebService, url: string): void {
    // The window may only send a tab to its own service.
    if (!belongsTo(service, url)) return
    void this.ensure(service).webContents.loadURL(url)
  }

  action(service: WebService, action: 'back' | 'forward' | 'reload' | 'home'): void {
    const wc = this.ensure(service).webContents
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'reload') wc.reload()
    else void wc.loadURL(SERVICES[service].home)
  }

  /**
   * Read the conversation currently on screen in a web tab, as plain text.
   * It reads the user's own page the way copy and paste would. The sites can
   * change their layout at any time, so this is best effort.
   */
  async capture(service: WebService): Promise<{ title: string; url: string; turns: { role: 'user' | 'assistant'; text: string }[] }> {
    const wc = this.ensure(service).webContents
    const script = `(() => {
      const clean = (s) => (s || '').replace(/\\n{3,}/g, '\\n\\n').trim();
      const turns = [];
      const tagged = document.querySelectorAll('[data-message-author-role]');
      if (tagged.length) {
        tagged.forEach((el) => {
          const role = el.getAttribute('data-message-author-role') === 'user' ? 'user' : 'assistant';
          const text = clean(el.innerText);
          if (text) turns.push({ role, text });
        });
      } else {
        const nodes = document.querySelectorAll('[data-testid="user-message"], .font-claude-response, .font-claude-message, [data-is-streaming]');
        nodes.forEach((el) => {
          const role = el.matches('[data-testid="user-message"]') ? 'user' : 'assistant';
          const text = clean(el.innerText);
          if (text) turns.push({ role, text });
        });
      }
      if (!turns.length) {
        const main = document.querySelector('main');
        const text = clean(main ? main.innerText : '');
        if (text) turns.push({ role: 'assistant', text });
      }
      return { title: document.title, url: location.href, turns };
    })()`
    return wc.executeJavaScript(script, true)
  }

  dispose(): void {
    this.hide()
    for (const v of this.views.values()) if (!v.webContents.isDestroyed()) v.webContents.close()
    this.views.clear()
  }
}
