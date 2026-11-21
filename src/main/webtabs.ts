// The app's own connection to claude.ai and chatgpt.com: one hidden page per site,
// which the app asks for the user's own data the way the site's page does. The
// sites are never shown in the main window. Signing in happens in a separate small
// window with the real sign-in page. Each site keeps its own sign-in, stored on this
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

// Tests point the tabs at stand-in sites on this machine, so no real site is contacted.
const TEST_ORIGINS: Partial<Record<WebService, string>> = (() => {
  try {
    return JSON.parse(process.env.CHAUDECAL_E2E_WEB_ORIGINS ?? '{}') as Partial<Record<WebService, string>>
  } catch {
    return {}
  }
})()

/** Where a site's own pages and data come from. */
export function siteOrigin(service: WebService): string {
  return TEST_ORIGINS[service] ?? (service === 'claude' ? 'https://claude.ai' : 'https://chatgpt.com')
}

function loginOf(service: WebService): string {
  const test = TEST_ORIGINS[service]
  if (test) return `${test}/login`
  return service === 'claude' ? 'https://claude.ai/login' : 'https://chatgpt.com/auth/login'
}

function homeOf(service: WebService): string {
  return TEST_ORIGINS[service] ? `${TEST_ORIGINS[service]}/` : SERVICES[service].home
}

/** Sign-in providers that may open in a popup. */
const AUTH_HOSTS = ['accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com', 'auth0.com', 'auth.openai.com']

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`))
}

export function belongsTo(service: WebService, url: string): boolean {
  const test = TEST_ORIGINS[service]
  if (test) return url === test || url.startsWith(`${test}/`)
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
  private signIns = new Map<WebService, Promise<boolean>>()

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
    // Never shown, but it keeps working at full speed while the app sends and reads messages through it.
    const view = new WebContentsView({ webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false } })
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
    void wc.loadURL(homeOf(service))
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
    else void wc.loadURL(homeOf(service))
  }

  /** Waits until the tab has finished loading its page. */
  private async settled(service: WebService): Promise<Electron.WebContents> {
    const wc = this.ensure(service).webContents
    if (wc.isLoading() || !wc.getURL()) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 30000)
        function done() {
          clearTimeout(timer)
          wc.off('did-stop-loading', done)
          resolve()
        }
        wc.on('did-stop-loading', done)
      })
    }
    return wc
  }

  /**
   * Asks the site for some of the user's own data, from inside its tab, the way the
   * site's own page does: with the tab's sign-in, and only from the site itself.
   * A status of 0 means the tab is not on the site (a sign-in page elsewhere) or the request failed.
   */
  async request(service: WebService, path: string, headers: Record<string, string> = {}, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: string }> {
    if (!path.startsWith('/')) throw new Error('Only paths on the site itself can be requested.')
    const wc = await this.settled(service)
    if (!belongsTo(service, wc.getURL()) || new URL(wc.getURL()).origin !== siteOrigin(service)) return { status: 0, body: '' }
    const options = { credentials: 'include', headers, ...(init.method ? { method: init.method } : {}), ...(init.body !== undefined ? { body: init.body } : {}) }
    const script = `fetch(${JSON.stringify(path)}, ${JSON.stringify(options)}).then(async (r) => ({ status: r.status, body: await r.text() }), (e) => ({ status: 0, body: String(e) }))`
    return (await wc.executeJavaScript(script, true)) as { status: number; body: string }
  }

  /** Sends one file to the site as a form upload, the way its own page does, with the page's sign-in. */
  async upload(service: WebService, path: string, file: { name: string; mime: string; base64: string }, field = 'file'): Promise<{ status: number; body: string }> {
    if (!path.startsWith('/')) throw new Error('Only paths on the site itself can be requested.')
    const wc = await this.settled(service)
    if (!belongsTo(service, wc.getURL()) || new URL(wc.getURL()).origin !== siteOrigin(service)) return { status: 0, body: '' }
    const script = `(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(file.base64)}), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append(${JSON.stringify(field)}, new File([bytes], ${JSON.stringify(file.name)}, { type: ${JSON.stringify(file.mime)} }));
      try { const r = await fetch(${JSON.stringify(path)}, { method: 'POST', credentials: 'include', body: form }); return { status: r.status, body: await r.text() }; }
      catch (e) { return { status: 0, body: String(e) }; }
    })()`
    return (await wc.executeJavaScript(script, true)) as { status: number; body: string }
  }

  /**
   * Like request, but the answer arrives in pieces as the site sends it, for
   * replies that are written while you watch. The page hands each piece back
   * through its console, tagged so nothing else on the page is mistaken for it.
   * Gives back the status once the answer has ended.
   */
  async stream(
    service: WebService,
    path: string,
    init: { method?: string; headers?: Record<string, string>; body?: string },
    onChunk: (text: string) => void,
    signal?: AbortSignal
  ): Promise<{ status: number; error?: string }> {
    if (!path.startsWith('/')) throw new Error('Only paths on the site itself can be requested.')
    const wc = await this.settled(service)
    if (!belongsTo(service, wc.getURL()) || new URL(wc.getURL()).origin !== siteOrigin(service)) return { status: 0, error: 'Not on the site.' }
    const token = `chaude${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`
    const tag = `\u0001${token}:`
    return new Promise((resolve) => {
      let status = 0
      let finished = false
      const finish = (error?: string) => {
        if (finished) return
        finished = true
        wc.off('console-message', listen)
        signal?.removeEventListener('abort', abort)
        resolve({ status, ...(error ? { error } : {}) })
      }
      const listen = (...args: unknown[]) => {
        // Newer Electron passes one object with the message, older ones pass it third.
        const first = args[0] as { message?: string }
        const message = typeof first?.message === 'string' ? first.message : String(args[2] ?? '')
        if (!message.startsWith(tag)) return
        let part: { k: string; v: unknown }
        try {
          part = JSON.parse(message.slice(tag.length))
        } catch {
          return
        }
        if (part.k === 'status') status = Number(part.v)
        else if (part.k === 'chunk') onChunk(String(part.v))
        else if (part.k === 'end') finish()
        else if (part.k === 'error') finish(String(part.v))
      }
      const abort = () => {
        void wc.executeJavaScript(`window[${JSON.stringify(token)}] && window[${JSON.stringify(token)}].abort()`, true).catch(() => {})
        finish('Stopped.')
      }
      wc.on('console-message', listen)
      signal?.addEventListener('abort', abort)
      const options = { method: init.method ?? 'GET', credentials: 'include', headers: init.headers ?? {}, ...(init.body !== undefined ? { body: init.body } : {}) }
      const script = `(async () => {
        const send = (k, v) => console.debug(${JSON.stringify(tag)} + JSON.stringify({ k, v }));
        const controller = new AbortController();
        window[${JSON.stringify(token)}] = controller;
        try {
          const r = await fetch(${JSON.stringify(path)}, { ...${JSON.stringify(options)}, signal: controller.signal });
          send('status', r.status);
          if (!r.ok || !r.body) { send('error', (await r.text()).slice(0, 2000)); return; }
          const reader = r.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            send('chunk', decoder.decode(value, { stream: true }));
          }
          send('end', 1);
        } catch (e) {
          send('error', String(e));
        } finally {
          delete window[${JSON.stringify(token)}];
        }
      })()`
      void wc.executeJavaScript(script, true).catch((e) => finish(String(e)))
    })
  }

  /** Runs a script in the site's hidden page and gives back its result. */
  async run<T>(service: WebService, script: string): Promise<T> {
    const wc = await this.settled(service)
    return (await wc.executeJavaScript(script, true)) as T
  }

  /** Types text into whatever has focus in the site's hidden page, as a keyboard would. */
  async insertText(service: WebService, text: string): Promise<void> {
    const wc = await this.settled(service)
    await wc.insertText(text)
  }

  /** Sends the hidden page to an address on the site and waits for it to load. */
  async open(service: WebService, path: string): Promise<void> {
    const url = `${siteOrigin(service)}${path}`
    if (!belongsTo(service, url)) return
    const wc = this.ensure(service).webContents
    await wc.loadURL(url).catch(() => {})
  }

  /** The address the hidden page is on now. */
  where(service: WebService): string {
    return this.ensure(service).webContents.getURL()
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

  /** Whether the user is signed in to the site in this app. */
  async signedIn(service: WebService): Promise<boolean> {
    try {
      if (service === 'claude') {
        const res = await this.request('claude', '/api/organizations')
        if (res.status !== 200) return false
        const orgs = JSON.parse(res.body) as unknown
        return Array.isArray(orgs) && orgs.length > 0
      }
      const res = await this.request('chatgpt', '/api/auth/session')
      return res.status === 200 && !!(JSON.parse(res.body) as { accessToken?: string }).accessToken
    } catch {
      return false
    }
  }

  /**
   * Opens the site's real sign-in page in a small window of its own. It closes by
   * itself once the sign-in has worked. Gives back whether the user is signed in.
   */
  signIn(service: WebService): Promise<boolean> {
    const running = this.signIns.get(service)
    if (running) return running
    const job = new Promise<boolean>((resolve) => {
      const partition = `persist:web-${service}`
      const parent = this.window()
      const win = new BrowserWindow({
        width: 520,
        height: 720,
        title: `Sign in to ${service === 'claude' ? 'claude.ai' : 'chatgpt.com'}`,
        autoHideMenuBar: true,
        ...(parent ? { parent } : {}),
        webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false }
      })
      win.webContents.setWindowOpenHandler(({ url }) => {
        try {
          const host = new URL(url).hostname
          if (hostMatches(host, SERVICES[service].hosts) || hostMatches(host, AUTH_HOSTS)) return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { partition, contextIsolation: true, sandbox: true, nodeIntegration: false } } }
        } catch {
          // Not a URL this app will open.
        }
        return { action: 'deny' }
      })
      let finished = false
      const finish = (ok: boolean) => {
        if (finished) return
        finished = true
        clearInterval(timer)
        if (!win.isDestroyed()) win.close()
        // The hidden page picks up the new sign-in.
        const view = this.views.get(service)
        if (view && !view.webContents.isDestroyed()) view.webContents.reload()
        resolve(ok)
      }
      const timer = setInterval(() => {
        void this.signedIn(service).then((ok) => ok && finish(true))
      }, 2000)
      win.on('closed', () => void this.signedIn(service).then(finish))
      void win.loadURL(loginOf(service))
    }).finally(() => this.signIns.delete(service))
    this.signIns.set(service, job)
    return job
  }

  /** Forgets the sign-in for this site in this app. */
  async signOut(service: WebService): Promise<void> {
    await session.fromPartition(`persist:web-${service}`).clearStorageData()
    const view = this.views.get(service)
    if (view && !view.webContents.isDestroyed()) void view.webContents.loadURL(homeOf(service))
  }

  dispose(): void {
    this.hide()
    for (const v of this.views.values()) if (!v.webContents.isDestroyed()) v.webContents.close()
    this.views.clear()
  }
}
