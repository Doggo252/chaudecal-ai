import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { API_METHODS, EVENT_CHANNELS } from '@shared/ipc'

// The window gets a fixed list of calls and nothing else from Electron or Node.
const api: Record<string, unknown> = {}
for (const name of API_METHODS) {
  api[name] = (...args: unknown[]) => ipcRenderer.invoke(`api:${name}`, ...args)
}
api.on = (channel: string, listener: (payload: unknown) => void) => {
  if (!(EVENT_CHANNELS as readonly string[]).includes(channel)) return () => {}
  const wrapped = (_event: IpcRendererEvent, payload: unknown) => listener(payload)
  ipcRenderer.on(`event:${channel}`, wrapped)
  return () => ipcRenderer.removeListener(`event:${channel}`, wrapped)
}

contextBridge.exposeInMainWorld('api', api)
