import { useEffect, useLayoutEffect } from 'react'
import { installCopyHandler } from './markdown'
import { openChat, setState, stepChat, useUi } from './state'
import { applyAccent, applyTextSize } from './theme'
import { ChatView } from './components/ChatView'
import { SearchDialog, ShortcutsBody, SwitchDialog } from './components/Dialogs'
import { SettingsView, UsageBody } from './components/Settings'
import { Modal } from './components/ui'
import { SHOW_LABEL, Sidebar } from './components/Sidebar'
import { ProjectsView } from './components/ProjectsView'
import { ProjectView } from './components/ProjectView'
import { ChatsView } from './components/ChatsView'
import { ArtifactsView } from './components/ArtifactsView'
import { Setup } from './components/Setup'
import { isWeb } from './webApi'
import { IconMenu } from './icons'

installCopyHandler()

export function App() {
  const ready = useUi((s) => s.app !== null)
  const platform = useUi((s) => s.app?.platform)
  const view = useUi((s) => s.view)
  const dialog = useUi((s) => s.dialog)
  const toast = useUi((s) => s.toast)
  const sideOpen = useUi((s) => s.sideOpen)
  const accent = useUi((s) => s.app?.settings.accent)
  const show = useUi((s) => s.show)
  const setupDone = useUi((s) => s.app?.setupDone !== false)
  // With one assistant shown, the window takes its name, so the app can stand in for it.
  useEffect(() => {
    document.title = SHOW_LABEL[show]
  }, [show])

  // Before the first paint, so the window never flashes in the default colors.
  useLayoutEffect(() => applyAccent(accent), [accent])
  const textSize = useUi((s) => s.app?.settings.textSize)
  useLayoutEffect(() => applyTextSize(textSize), [textSize])

  useEffect(() => {
    // The menu shortcuts cover these on macOS. This keeps them working everywhere.
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      const key = e.key.toLowerCase()
      if (key === 'k') {
        e.preventDefault()
        setState({ dialog: { kind: 'search' } })
      } else if (key === 'n' && !e.shiftKey) {
        e.preventDefault()
        openChat(undefined)
      } else if (key === '/') {
        e.preventDefault()
        setState({ dialog: { kind: 'shortcuts' } })
      } else if (key === ',') {
        e.preventDefault()
        setState({ view: { kind: 'settings' }, dialog: null })
      } else if (e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
        e.preventDefault()
        stepChat(e.code === 'BracketRight' ? 1 : -1)
      } else if (e.shiftKey && key === 'd') {
        e.preventDefault()
        window.dispatchEvent(new Event('chaude-toggle-changes'))
      } else if (e.shiftKey && key === 'e') {
        e.preventDefault()
        window.dispatchEvent(new Event('chaude-open-editor'))
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  if (!ready) return <div className="app" />

  return (
    <div className={`app ${isWeb() ? 'web' : platform === 'darwin' ? 'mac' : 'win'} ${sideOpen ? 'side-open' : ''}`}>
      <button type="button" className="side-toggle" title="Chats" data-testid="side-toggle" onClick={() => setState((s) => ({ sideOpen: !s.sideOpen }))}>
        <IconMenu />
      </button>
      <div className="side-scrim" onClick={() => setState({ sideOpen: false })} />
      <Sidebar />
      <main className="main">
        {view.kind === 'chat' && <ChatView key={view.conversationId ?? 'new'} conversationId={view.conversationId} focusMessageId={view.focusMessageId} />}
        {view.kind === 'settings' && <SettingsView tab={view.tab} />}
        {view.kind === 'project' && <ProjectView key={view.projectId} projectId={view.projectId} />}
        {view.kind === 'projects' && <ProjectsView />}
        {view.kind === 'chats' && <ChatsView />}
        {view.kind === 'artifacts' && <ArtifactsView />}
      </main>
      {!setupDone && !isWeb() && <Setup />}
      {dialog?.kind === 'search' && <SearchDialog />}
      {dialog?.kind === 'usage' && (
        <Modal title="Usage" testId="usage-dialog" wide onClose={() => setState({ dialog: null })}>
          <div className="modal-body">
            <UsageBody />
          </div>
        </Modal>
      )}
      {dialog?.kind === 'shortcuts' && (
        <Modal title="Keyboard shortcuts" testId="shortcuts-dialog" onClose={() => setState({ dialog: null })}>
          <div className="modal-body">
            <ShortcutsBody mac={platform === 'darwin'} />
          </div>
        </Modal>
      )}
      {dialog?.kind === 'switch' && <SwitchDialog conversationId={dialog.conversationId} target={dialog.target} />}
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}
