// Accepted phrases — ordered longest-first to reduce false positives
const START_PHRASES = ['begin trial', 'start trial', 'begin recording', 'start recording', 'begin', 'start']
const STOP_PHRASES  = ['end trial', 'stop trial', 'end recording', 'stop recording', 'finish trial', 'end', 'stop', 'finish']

function matchesAny(text, phrases) {
  return phrases.some(p => text.includes(p))
}

export class VoiceController {
  constructor({ onStart, onStop, onTranscript, onInterim, onStatusChange }) {
    this.onStart        = onStart
    this.onStop         = onStop
    this.onTranscript   = onTranscript   // final result
    this.onInterim      = onInterim      // live partial result
    this.onStatusChange = onStatusChange

    this._recognition = null
    this._active      = false
    this._supported   = 'SpeechRecognition' in window || 'webkitSpeechRecognition' in window
  }

  get supported() { return this._supported }
  get active()    { return this._active }

  start() {
    if (!this._supported || this._active) return

    const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition
    const r  = new SR()
    r.continuous        = true
    r.interimResults    = true   // stream partial results for live display
    r.lang              = 'en-US'
    r.maxAlternatives   = 3

    r.onstart = () => {
      // Only notify on the very first activation — not on every auto-restart.
      // Each onend→r.start() cycle would otherwise spam DOM updates.
      const firstStart = !this._active
      this._active = true
      if (firstStart) this.onStatusChange?.('listening')
    }

    r.onend = () => {
      // Auto-restart while still supposed to be active
      if (this._active) {
        try { r.start() } catch (_) {}
      } else {
        this.onStatusChange?.('off')
      }
    }

    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this._active = false
        this.onStatusChange?.('error')
      }
      // network / no-speech errors are transient — let onend restart
    }

    r.onresult = (event) => {
      let interim = ''
      let finalText = ''

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i]
        // Collect all alternatives for better matching
        const alts = Array.from({ length: result.length }, (_, j) => result[j].transcript.toLowerCase().trim())

        if (result.isFinal) {
          // Try all alternatives for a command match
          const matched = alts.find(t => matchesAny(t, START_PHRASES) || matchesAny(t, STOP_PHRASES))
          const text = matched ?? alts[0]
          finalText += text

          this.onTranscript?.(text, alts)

          if (matchesAny(text, START_PHRASES)) this.onStart?.()
          else if (matchesAny(text, STOP_PHRASES)) this.onStop?.()
        } else {
          interim += alts[0]
        }
      }

      if (interim) this.onInterim?.(interim)
    }

    this._recognition = r
    r.start()
  }

  stop() {
    this._active = false
    this._recognition?.stop()
    this._recognition = null
    this.onStatusChange?.('off')
  }

  toggle() {
    if (this._active) this.stop()
    else this.start()
  }
}
