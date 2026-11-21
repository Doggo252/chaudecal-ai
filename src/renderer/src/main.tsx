import { StrictMode, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { QuickAsk } from './components/QuickAsk'
import { boot } from './state'
import { installWebApi, savedCode, tryCode } from './webApi'
// Where the Mac's own fonts are missing (Windows, Android), these open fonts stand in for them, so the app looks the same everywhere.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/inter/opsz-italic.css'
import '@fontsource-variable/source-serif-4/opsz.css'
import '@fontsource-variable/source-serif-4/opsz-italic.css'
import './styles.css'

/** In a browser, before anything else: the pairing code from the hub. */
function Pairing() {
  const [code, setCode] = useState('')
  const [wrong, setWrong] = useState(false)
  return (
    <div className="pairing">
      <h1>Chaude</h1>
      <p>Enter the pairing code shown on the hub machine, under Settings, "Sync and hub".</p>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void tryCode(code).then((ok) => (ok ? location.reload() : setWrong(true)))
        }}
      >
        <input className="input" data-testid="pairing-code" value={code} autoFocus autoComplete="off" onChange={(e) => setCode(e.target.value)} placeholder="Pairing code" />
        <button type="submit" className="btn btn-primary" data-testid="pairing-go">
          Connect
        </button>
      </form>
      {wrong && <p className="pairing-wrong">That code did not work. Check it on the hub and try again.</p>}
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
// The desktop app has its bridge already. In a browser the page talks to the hub instead.
const inBrowser = !window.api
const code = inBrowser ? savedCode() : null
if (inBrowser && code) installWebApi(code)

if (inBrowser && !code) {
  root.render(<Pairing />)
} else {
  void boot()
  root.render(<StrictMode>{location.hash === '#quick' ? <QuickAsk /> : <App />}</StrictMode>)
}
