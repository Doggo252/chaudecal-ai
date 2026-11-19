import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { QuickAsk } from './components/QuickAsk'
import { boot } from './state'
import './styles.css'

void boot()
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.hash === '#quick' ? <QuickAsk /> : <App />}
  </StrictMode>
)
