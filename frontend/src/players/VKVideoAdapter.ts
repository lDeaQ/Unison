import { BasePlayerAdapter } from './IPlayerAdapter'

const VK_PLAYER_SCRIPT = 'https://vk.com/js/api/videoplayer.js'
const VK_EMBED_ORIGIN = 'https://vk.com'

declare global {
  interface Window {
    VK?: {
      VideoPlayer(iframe: HTMLIFrameElement): VKPlayerInstance
    }
  }
}

interface VKPlayerInstance {
  play(): void
  pause(): void
  seek(seconds: number): void
  setCurrentTime(seconds: number): void
  setPlaybackRate?(rate: number): void
  on(event: string, cb: (data?: unknown) => void): void
  off?(event: string, cb: (data?: unknown) => void): void
  destroy?(): void
}

// Единый промис загрузки скрипта — избегаем дублирования при нескольких адаптерах
let vkScriptPromise: Promise<void> | null = null

function loadVKScript(): Promise<void> {
  if (window.VK?.VideoPlayer) return Promise.resolve()
  if (vkScriptPromise) return vkScriptPromise

  vkScriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = VK_PLAYER_SCRIPT
    script.onload = () => resolve()
    script.onerror = () => {
      vkScriptPromise = null
      reject(new Error('Не удалось загрузить VK VideoPlayer SDK'))
    }
    document.head.appendChild(script)
  })

  return vkScriptPromise
}

function extractVKIds(url: string): { oid: number; id: number } {
  // Форматы: vk.com/video-123_456 (группа, oid<0) или vk.com/video123_456 (пользователь, oid>0)
  const match = /video(-?\d+)_(\d+)/.exec(url)
  if (!match) throw new Error(`Не удалось извлечь oid/id из URL VK Video: ${url}`)
  return { oid: Number(match[1]), id: Number(match[2]) }
}

export class VKVideoAdapter extends BasePlayerAdapter {
  private readonly iframe: HTMLIFrameElement
  private player: VKPlayerInstance | null = null
  private ready = false
  private currentTimeSec = 0
  private durationSec = 0

  private pendingSeekSec: number | null = null
  // VK иногда игнорирует seek сразу после inited — аналог паттерна из RutubeAdapter
  private justBecameReady = false

  constructor(url: string, container: HTMLElement) {
    super()
    const { oid, id } = extractVKIds(url)
    const embedUrl = `${VK_EMBED_ORIGIN}/video_ext.php?oid=${oid}&id=${id}&js_api=1&hd=2`

    this.iframe = document.createElement('iframe')
    this.iframe.src = embedUrl
    this.iframe.style.width = '100%'
    this.iframe.style.height = '100%'
    this.iframe.style.border = 'none'
    this.iframe.setAttribute('allow', 'autoplay; fullscreen')
    this.iframe.setAttribute('allowfullscreen', '')
    container.appendChild(this.iframe)

    void this.initPlayer()
  }

  private async initPlayer(): Promise<void> {
    try {
      await loadVKScript()
      if (!window.VK?.VideoPlayer) throw new Error('VK.VideoPlayer недоступен после загрузки скрипта')
      this.player = window.VK.VideoPlayer(this.iframe)
      this.bindEvents()
    } catch (err) {
      console.error('[VKVideoAdapter] Ошибка инициализации плеера:', err)
      this.emit('error', err)
    }
  }

  private bindEvents(): void {
    if (!this.player) return
    this.player.on('inited', () => this.onPlayerReady())
    this.player.on('started', () => this.emit('play'))
    this.player.on('resumed', () => this.emit('play'))
    this.player.on('paused', () => this.emit('pause'))
    this.player.on('timeupdate', (data) => {
      const d = data as { time?: number; duration?: number } | undefined
      if (typeof d?.time === 'number') {
        this.currentTimeSec = d.time
        this.emit('timeupdate', this.currentTimeSec)
      }
      if (typeof d?.duration === 'number' && d.duration > 0) {
        this.durationSec = d.duration
      }
    })
    this.player.on('error', (data) => {
      console.error('[VKVideoAdapter] error', data)
      this.emit('error', data)
    })
  }

  async play(): Promise<void> {
    if (!this.ready || !this.player) return
    this.player.play()
  }

  async pause(): Promise<void> {
    if (!this.ready || !this.player) return
    this.player.pause()
  }

  async seek(seconds: number): Promise<void> {
    console.log('[VKVideoAdapter] seek() called, seconds=', seconds, 'ready=', this.ready)
    if (!Number.isFinite(seconds) || seconds < 0) {
      console.warn('[VKVideoAdapter] seek: невалидное значение', seconds, '— игнорируем')
      return
    }
    if (!this.ready || !this.player) {
      this.pendingSeekSec = seconds
      return
    }
    if (this.justBecameReady) {
      this.justBecameReady = false
      await new Promise<void>((r) => setTimeout(r, 500))
    }
    this.player.seek(seconds)
    this.currentTimeSec = seconds
  }

  async setPlaybackRate(rate: number): Promise<void> {
    if (!this.player) {
      console.warn('[VKVideoAdapter] setPlaybackRate: плеер не инициализирован')
      return
    }
    if (typeof this.player.setPlaybackRate === 'function') {
      this.player.setPlaybackRate(rate)
    } else {
      console.warn(`[VKVideoAdapter] setPlaybackRate(${rate}) не поддерживается текущей версией VK VideoPlayer API`)
    }
  }

  async getCurrentTime(): Promise<number> {
    return this.currentTimeSec
  }

  async getDuration(): Promise<number> {
    return this.durationSec
  }

  isReady(): boolean {
    return this.ready
  }

  destroy(): void {
    this.player?.destroy?.()
    this.iframe.remove()
    this.ready = false
    this.player = null
    this.pendingSeekSec = null
    this.listeners.clear()
  }

  private onPlayerReady(): void {
    this.ready = true
    this.justBecameReady = true
    console.log('[VKVideoAdapter] onReady, applying pendingSeekSec=', this.pendingSeekSec)
    if (this.pendingSeekSec !== null) {
      this.player?.seek(this.pendingSeekSec)
      this.currentTimeSec = this.pendingSeekSec
      this.pendingSeekSec = null
    }
    this.emit('ready')
  }
}
