import { useEffect, useRef, useState } from 'react'
import { speakableText } from '@shared/speech'
import { toast, useUi } from '../state'
import { IconMic, IconSpeaker } from '../icons'

const isMac = () => navigator.platform.toLowerCase().includes('mac')

/** Records speech and turns it into text with the speech-to-text server in the settings. */
export function DictationButton({ onText }: { onText: (text: string) => void }) {
  const configured = useUi((s) => !!s.app?.settings.local.speechUrl?.trim())
  const [state, setState] = useState<'idle' | 'recording' | 'working'>('idle')
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])

  useEffect(() => () => recorder.current?.stream.getTracks().forEach((t) => t.stop()), [])

  const start = async () => {
    if (!configured) {
      toast(`Set up a speech-to-text server under Settings, Local AI, or use your computer's own dictation: ${isMac() ? 'press Fn twice' : 'press Windows key + H'} in the message box.`)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const rec = new MediaRecorder(stream)
      chunks.current = []
      rec.ondataavailable = (e) => e.data.size && chunks.current.push(e.data)
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        setState('working')
        const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
        const res = await window.api.transcribe(new Uint8Array(await blob.arrayBuffer()), blob.type)
        setState('idle')
        if (res.error) toast(res.error)
        else if (res.text) onText(res.text)
      }
      recorder.current = rec
      rec.start()
      setState('recording')
    } catch {
      toast('The microphone could not be used. Check that the app may use it in your system settings.')
    }
  }

  const stop = () => recorder.current?.state === 'recording' && recorder.current.stop()

  return (
    <button
      type="button"
      className={`icon-btn ${state === 'recording' ? 'recording' : ''}`}
      title={state === 'recording' ? 'Stop and turn into text' : configured ? 'Dictate' : 'Dictate (needs a speech-to-text server)'}
      data-testid="dictate"
      data-state={state}
      disabled={state === 'working'}
      onClick={() => (state === 'recording' ? stop() : void start())}
    >
      {state === 'working' ? <span className="spinner" /> : <IconMic />}
    </button>
  )
}

let speaking: string | undefined
const listeners = new Set<() => void>()
const changed = () => listeners.forEach((l) => l())

/** Reads a reply aloud with the computer's own voice, or stops if it is already reading it. */
export function ReadAloudButton({ id, text }: { id: string; text: string }) {
  const [, redraw] = useState(0)
  useEffect(() => {
    const l = () => redraw((n) => n + 1)
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  }, [])
  const on = speaking === id
  const toggle = () => {
    speechSynthesis.cancel()
    if (on) {
      speaking = undefined
      changed()
      return
    }
    const words = speakableText(text)
    if (!words) return
    const u = new SpeechSynthesisUtterance(words)
    u.lang = navigator.language
    u.onend = u.onerror = () => {
      if (speaking === id) speaking = undefined
      changed()
    }
    speaking = id
    changed()
    speechSynthesis.speak(u)
  }
  return (
    <button type="button" className={`icon-btn ${on ? 'on' : ''}`} title={on ? 'Stop reading' : 'Read aloud'} data-testid="read-aloud" onClick={toggle}>
      <IconSpeaker size={15} />
    </button>
  )
}
