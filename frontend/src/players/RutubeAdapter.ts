import { BasePlayerAdapter } from './IPlayerAdapter'

// Единица времени для player:setCurrentTime / player:currentTime.
// false = секунды (предположение по умолчанию, типично для HTML5-based плееров).
// true  = миллисекунды. Сменить если после проверки первого player:currentTime
// окажется, что значение в мс, а не в секундах.
const TIME_UNIT_MS = false

const RUTUBE_ORIGIN = 'https://rutube.ru'

interface RutubeEvent {
  type: string
  data?: unknown
}

function isRutubeEvent(v: unknown): v is RutubeEvent {
  return (
    typeof v === 'object' &&
    v !== null &&
    'type' in v &&
    typeof (v as { type: unknown }).type === 'string'
  )
}

function extractVideoId(url: string): string {
  const match = /rutube\.ru\/(?:video|play\/embed)\/([a-zA-Z0-9]+)/i.exec(url)
  if (!match) {
    throw new Error(`Не удалось извлечь video_id из URL: ${url}`)
  }
  return match[1]
}

export class RutubeAdapter extends BasePlayerAdapter {
  private readonly iframe: HTMLIFrameElement
  private ready = false
  private currentTimeSec = 0
  private durationSec = 0

  // Логируем первые несколько ненулевых player:currentTime для определения единицы
  private loggedCurrentTimeCount = 0
  private readonly LOG_CURRENT_TIME_LIMIT = 5

  // Буфер команд до события player:ready
  private pendingSeekSec: number | null = null

  // RuTube бросает NaN если seek приходит сразу после player:ready — нужна пауза 500мс
  private justBecameReady = false

  private readonly messageHandler: (e: MessageEvent) => void

  constructor(url: string, container: HTMLElement) {
    super()
    const videoId = extractVideoId(url)
    const embedUrl = `${RUTUBE_ORIGIN}/play/embed/${videoId}`

    this.iframe = document.createElement('iframe')
    this.iframe.src = embedUrl
    this.iframe.style.width = '100%'
    this.iframe.style.height = '100%'
    this.iframe.style.border = 'none'
    this.iframe.setAttribute('allow', 'autoplay; fullscreen')
    this.iframe.setAttribute('allowfullscreen', '')
    container.appendChild(this.iframe)

    this.messageHandler = (e: MessageEvent) => this.onMessage(e)
    window.addEventListener('message', this.messageHandler)
  }

  async play(): Promise<void> {
    if (!this.ready) return
    this.sendToPlayer({ type: 'player:play' })
  }

  async pause(): Promise<void> {
    if (!this.ready) return
    this.sendToPlayer({ type: 'player:pause' })
  }

  async seek(seconds: number): Promise<void> {
    console.log('[RutubeAdapter] seek() called, seconds=', seconds, 'ready=', this.ready, 'pending=', this.pendingSeekSec)
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.warn('[RutubeAdapter] seek: невалидное значение', seconds, '— игнорируем')
      return
    }
    if (!this.ready) {
      this.pendingSeekSec = seconds
      return
    }
    if (this.justBecameReady) {
      this.justBecameReady = false
      await new Promise<void>((r) => setTimeout(r, 1000))
    }
    const time = TIME_UNIT_MS ? seconds * 1000 : seconds
    this.sendToPlayer({ type: 'player:setCurrentTime', data: { time } })
    this.currentTimeSec = seconds
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (rate !== 1.0) {
      console.warn(
        `[RutubeAdapter] setPlaybackRate(${rate}) не поддерживается RuTube embed API. ` +
          'Команда проигнорирована. Видео продолжит воспроизводиться со скоростью 1x.',
      )
    }
    // Resolve без действия — RuTube embed API не имеет команды смены скорости
  }

  async getCurrentTime(): Promise<number> {
    return this.currentTimeSec
  }

  async getDuration(): Promise<number> {
    return this.durationSec
  }

  getDurationMs(): number {
    return this.durationSec * 1000
  }

  isReady(): boolean {
    return this.ready
  }

  destroy(): void {
    window.removeEventListener('message', this.messageHandler)
    this.iframe.remove()
    this.ready = false
    this.pendingSeekSec = null
    this.listeners.clear()
  }

  private sendToPlayer(data: Record<string, unknown>): void {
    this.iframe.contentWindow?.postMessage(JSON.stringify(data), RUTUBE_ORIGIN)
  }

  private onMessage(e: MessageEvent): void {
    // Двойная фильтрация: source исключает чужие iframe, origin защищает от инъекций
    if (e.source !== this.iframe.contentWindow) return
    if (e.origin !== RUTUBE_ORIGIN) return

    let parsed: unknown
    try {
      parsed = typeof e.data === 'string' ? JSON.parse(e.data) : e.data
    } catch {
      return
    }

    if (!isRutubeEvent(parsed)) return

    switch (parsed.type) {
      case 'player:ready':
        this.onPlayerReady()
        break

      case 'player:changeState': {
        const d = parsed.data as { state?: string } | undefined
        if (d?.state === 'playing') this.emit('play')
        else if (d?.state === 'paused' || d?.state === 'stopped') this.emit('pause')
        break
      }

      case 'player:currentTime': {
        const d = parsed.data as { time?: number } | undefined
        if (typeof d?.time === 'number') {
          // Логируем первые N ненулевых значений — для определения единицы времени.
          // Если raw ~ секунды (1, 2, 3...) → TIME_UNIT_MS=false верно.
          // Если raw ~ тысячи (1000, 2000...) → нужно TIME_UNIT_MS=true.
          if (this.loggedCurrentTimeCount < this.LOG_CURRENT_TIME_LIMIT && d.time > 0) {
            this.loggedCurrentTimeCount++
            const interpretedSec = TIME_UNIT_MS ? d.time / 1000 : d.time
            console.log(
              `[RutubeAdapter] player:currentTime #${this.loggedCurrentTimeCount}: ` +
                `raw=${d.time} → ${interpretedSec.toFixed(3)} сек (TIME_UNIT_MS=${TIME_UNIT_MS})`,
            )
          }
          this.currentTimeSec = TIME_UNIT_MS ? d.time / 1000 : d.time
          this.emit('timeupdate', this.currentTimeSec)
        }
        break
      }

      case 'player:durationChange': {
        const d = parsed.data as { duration?: number } | undefined
        if (typeof d?.duration === 'number') {
          this.durationSec = TIME_UNIT_MS ? d.duration / 1000 : d.duration
        }
        break
      }

      case 'player:playComplete':
        this.emit('ended')
        break

      case 'player:error':
        console.error('[RutubeAdapter] player:error', parsed.data)
        this.emit('error', parsed.data)
        break
    }
  }

  private onPlayerReady(): void {
    this.ready = true
    this.justBecameReady = true
    console.log('[RutubeAdapter] onReady, applying pendingSeekSec=', this.pendingSeekSec)
    if (this.pendingSeekSec !== null) {
      const time = TIME_UNIT_MS ? this.pendingSeekSec * 1000 : this.pendingSeekSec
      this.sendToPlayer({ type: 'player:setCurrentTime', data: { time } })
      this.currentTimeSec = this.pendingSeekSec
      this.pendingSeekSec = null
    }
    this.emit('ready')
  }
}
