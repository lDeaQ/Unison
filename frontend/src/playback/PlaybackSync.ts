import type {
  ClientMessage,
  PersonalPlayPayload,
  PlayBroadcastPayload,
  PauseBroadcastPayload,
  SeekBroadcastPayload,
  SetPlaybackRateBroadcastPayload,
  WelcomePayload,
} from '../types/protocol'
import {
  type PlaybackState,
  computeCurrentPositionMs,
  applyPlay,
  applyPause,
  applySeek,
  serverMsToLocalPerfNow,
} from './playbackMath'
import type { IPlayerAdapter } from '../players/IPlayerAdapter'

type SendFn = (msg: ClientMessage) => void
type CommandType = 'Play' | 'Pause' | 'Seek' | 'SetPlaybackRate'

const LATE_THRESHOLD_MS = -50

export class PlaybackSync {
  private state: PlaybackState = {
    isPlaying: false,
    positionMs: 0,
    anchorPerfNowMs: 0,
    playbackRate: 1.0,
    videoUrl: '',
  }
  private readonly pendingTimers: Map<CommandType, ReturnType<typeof setTimeout>> = new Map()
  private readonly listeners: Set<() => void> = new Set()
  private readonly syncedListeners: Set<() => void> = new Set()
  private readonly send: SendFn
  private readonly getOffset: () => number
  private readonly getOffsetReady: () => boolean
  private adapter: IPlayerAdapter | null = null

  constructor(
    send: SendFn,
    getOffset: () => number,
    getOffsetReady: () => boolean,
  ) {
    this.send = send
    this.getOffset = getOffset
    this.getOffsetReady = getOffsetReady
  }

  // --- Адаптер плеера ---

  setAdapter(adapter: IPlayerAdapter | null): void {
    this.adapter = adapter
    if (!adapter) return

    const applyState = () => {
      if (this.adapter !== adapter) return

      const positionMs = this.currentPositionMs()
      const seekSec = positionMs / 1000
      console.log('[PlaybackSync] setAdapter seek, positionMs=', positionMs)
      if (Number.isFinite(seekSec) && seekSec > 0.5) {
        adapter.seek(seekSec)
      }

      if (!this.state.isPlaying) return

      // Сессия воспроизводится. После seek RuTube переходит в paused —
      // это сигнал готовности буфера. Отправляем SeekReady, сервер ответит
      // PersonalPlay. play() вызовет onPersonalPlayBroadcast, не мы.
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(fallbackTimer)
        adapter.off('pause', onPause)
        this.send({ type: 'SeekReady', payload: {} })
      }
      const onPause = () => finish()
      // 8 секунд — защита на случай если RuTube не пришлёт paused (медленный буфер)
      const fallbackTimer = setTimeout(finish, 8000)
      adapter.on('pause', onPause)
    }

    const onEnded = () => {
      if (this.adapter !== adapter) return
      this.requestPause()
    }
    adapter.on('ended', onEnded)

    if (adapter.isReady()) {
      applyState()
    } else {
      const onReady = () => {
        adapter.off('ready', onReady)
        applyState()
      }
      adapter.on('ready', onReady)
    }
  }

  // --- Входящие бродкасты ---

  onPlayBroadcast(p: PlayBroadcastPayload): void {
    this.scheduleApply('Play', p.execute_at_ms, (localExecAt) => {
      this.state = applyPlay(this.state, localExecAt)
      this.adapter?.play()
    })
  }

  onPauseBroadcast(p: PauseBroadcastPayload): void {
    this.scheduleApply('Pause', p.execute_at_ms, (localExecAt) => {
      this.state = applyPause(this.state, localExecAt)
      this.adapter?.pause()
    })
  }

  onSeekBroadcast(p: SeekBroadcastPayload): void {
    this.scheduleApply('Seek', p.execute_at_ms, (localExecAt) => {
      this.state = applySeek(this.state, localExecAt, p.position_ms)
      this.adapter?.seek(p.position_ms / 1000)  // мс → секунды (интерфейс адаптера в секундах)
    })
  }

  onSetPlaybackRateBroadcast(p: SetPlaybackRateBroadcastPayload): void {
    this.scheduleApply('SetPlaybackRate', p.execute_at_ms, (localExecAt) => {
      // position_ms из payload — авторитетное серверное значение на момент execute_at,
      // не пересчитываем локально (см. §5.6 плана)
      this.state = {
        isPlaying: this.state.isPlaying,
        positionMs: p.position_ms,
        anchorPerfNowMs: localExecAt,
        playbackRate: p.rate,
        videoUrl: this.state.videoUrl,
      }
      this.adapter?.setPlaybackRate(p.rate)
    })
  }

  // --- PersonalPlay (unicast при входе в играющую сессию) ---

  onPersonalPlayBroadcast(p: PersonalPlayPayload): void {
    console.log('[PlaybackSync] onPersonalPlay:', p)
    // Оверлей убирается при получении PersonalPlay — плеер уже в паузе,
    // буфер готов; execute_at ещё впереди, но визуальный "прыжок" исключён.
    this.emitSynced()
    this.scheduleApply('Play', p.execute_at_ms, (localExecAt) => {
      // applyPlay сохраняет state.positionMs, но для нового клиента нужна
      // авторитетная позиция от сервера — вручную обновляем оба поля.
      this.state = {
        ...this.state,
        isPlaying: true,
        positionMs: p.position_ms,
        anchorPerfNowMs: localExecAt,
      }
      // Seek к серверной позиции на execute_at — компенсирует drift
      // между первым seek (в setAdapter) и моментом старта.
      this.adapter?.seek(p.position_ms / 1000)
      this.adapter?.play()
    })
  }

  // --- VideoUrlChanged ---

  onVideoUrlChanged(): void {
    this.state = {
      ...this.state,
      isPlaying: false,
      positionMs: 0,
      anchorPerfNowMs: performance.now(),
    }
    this.pendingTimers.forEach(clearTimeout)
    this.pendingTimers.clear()
    this.emitChange()
  }

  // --- Welcome ---

  onWelcome(w: WelcomePayload): void {
    // Все запланированные команды относятся к прошлому состоянию — отменяем
    this.pendingTimers.forEach((t) => clearTimeout(t))
    this.pendingTimers.clear()

    let anchorPerfNowMs: number
    if (w.is_playing && this.getOffsetReady()) {
      // ClockSync уже дал хотя бы одно измерение: пересчитываем server_time_ms в localPerfNow,
      // чтобы anchor соответствовал моменту отправки Welcome (убирает погрешность ≈ RTT/2)
      anchorPerfNowMs = serverMsToLocalPerfNow(w.server_time_ms, this.getOffset())
    } else {
      anchorPerfNowMs = performance.now()
      if (w.is_playing) {
        console.info(
          '[PlaybackSync] Welcome в playing-состоянии до готовности ClockSync — ' +
            'погрешность позиции ≈ RTT/2 до первой синхронизации часов',
        )
      }
    }

    const welcomeState: PlaybackState = {
      isPlaying: w.is_playing,
      positionMs: w.position_ms,
      anchorPerfNowMs,
      playbackRate: w.playback_rate,
      videoUrl: w.video_url,
    }

    // Уточняем позицию с поправкой на время в пути (RTT/2), если offset уже готов.
    // Если вычисление даёт нефинитное число (offset=NaN из-за гонки в ClockSync) —
    // откатываемся на серверное position_ms без поправки.
    const computedPos = this.getOffsetReady()
      ? computeCurrentPositionMs(welcomeState, performance.now())
      : w.position_ms
    if (!Number.isFinite(computedPos)) {
      this.state = { ...welcomeState, positionMs: w.position_ms }
      console.info('[PlaybackSync] onWelcome: computedPos нефинитен — используем position_ms без коррекции')
    } else {
      this.state = { ...welcomeState, positionMs: computedPos }
    }

    console.log('[PlaybackSync] onWelcome applied, positionMs=', this.state.positionMs)
    this.emitChange()
  }

  // --- Действия пользователя (только send; state меняется после бродкаста) ---

  requestPlay(): void {
    console.log('[PlaybackSync] requestPlay, state.positionMs=', this.state.positionMs)
    this.send({ type: 'Play', payload: { position_ms: this.currentPositionMs() } })
  }

  requestPause(): void {
    this.send({ type: 'Pause', payload: { position_ms: this.currentPositionMs() } })
  }

  requestSeek(positionMs: number): void {
    this.send({ type: 'Seek', payload: { position_ms: Math.round(positionMs) } })
  }

  requestSetRate(rate: number): void {
    this.send({ type: 'SetPlaybackRate', payload: { rate } })
  }

  // --- Публичные геттеры и подписка ---

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onSynced(cb: () => void): () => void {
    this.syncedListeners.add(cb)
    return () => this.syncedListeners.delete(cb)
  }

  getState(): Readonly<PlaybackState> {
    return this.state
  }

  currentPositionMs(): number {
    return computeCurrentPositionMs(this.state, performance.now())
  }

  destroy(): void {
    this.pendingTimers.forEach((t) => clearTimeout(t))
    this.pendingTimers.clear()
    this.listeners.clear()
    this.syncedListeners.clear()
  }

  // --- Планирование применения команды ---

  private scheduleApply(
    cmdType: CommandType,
    executeAtServerMs: number,
    applyFn: (localExecAtPerfNow: number) => void,
  ): void {
    const prev = this.pendingTimers.get(cmdType)
    if (prev !== undefined) clearTimeout(prev)

    const localExecAtPerfNow = executeAtServerMs - this.getOffset()
    const delayMs = localExecAtPerfNow - performance.now()
    console.log('[PlaybackSync] scheduleApply', cmdType, 'delay=', delayMs.toFixed(1) + 'ms')

    if (delayMs > 0) {
      const t = setTimeout(() => {
        applyFn(localExecAtPerfNow)
        this.pendingTimers.delete(cmdType)
        this.emitChange()
      }, delayMs)
      this.pendingTimers.set(cmdType, t)
    } else if (delayMs > LATE_THRESHOLD_MS) {
      // Незначительное опоздание (≤50мс) — применяем без предупреждения
      applyFn(localExecAtPerfNow)
      this.emitChange()
    } else {
      // Существенное опоздание (>50мс): anchor в прошлом, формула автоматически
      // компенсирует пропущенное время через computeCurrentPositionMs
      applyFn(localExecAtPerfNow)
      this.emitChange()
      console.warn(`[PlaybackSync] ${cmdType} late by ${(-delayMs).toFixed(1)}ms`)
    }
  }

  private emitChange(): void {
    this.listeners.forEach((cb) => cb())
  }

  private emitSynced(): void {
    this.syncedListeners.forEach((cb) => cb())
  }
}
