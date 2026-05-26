import type {
  ClientMessage,
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
  private readonly send: SendFn
  private readonly getOffset: () => number
  private readonly getOffsetReady: () => boolean

  constructor(
    send: SendFn,
    getOffset: () => number,
    getOffsetReady: () => boolean,
  ) {
    this.send = send
    this.getOffset = getOffset
    this.getOffsetReady = getOffsetReady
  }

  // --- Входящие бродкасты ---

  onPlayBroadcast(p: PlayBroadcastPayload): void {
    this.scheduleApply('Play', p.execute_at_ms, (localExecAt) => {
      this.state = applyPlay(this.state, localExecAt)
    })
  }

  onPauseBroadcast(p: PauseBroadcastPayload): void {
    this.scheduleApply('Pause', p.execute_at_ms, (localExecAt) => {
      this.state = applyPause(this.state, localExecAt)
    })
  }

  onSeekBroadcast(p: SeekBroadcastPayload): void {
    this.scheduleApply('Seek', p.execute_at_ms, (localExecAt) => {
      this.state = applySeek(this.state, localExecAt, p.position_ms)
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
    })
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

    this.state = {
      isPlaying: w.is_playing,
      positionMs: w.position_ms,
      anchorPerfNowMs,
      playbackRate: w.playback_rate,
      videoUrl: w.video_url,
    }
    this.emitChange()
  }

  // --- Действия пользователя (только send; state меняется после бродкаста) ---

  requestPlay(): void {
    this.send({ type: 'Play', payload: { position_ms: this.currentPositionMs() } })
  }

  requestPause(): void {
    this.send({ type: 'Pause', payload: { position_ms: this.currentPositionMs() } })
  }

  requestSeek(positionMs: number): void {
    this.send({ type: 'Seek', payload: { position_ms: positionMs } })
  }

  requestSetRate(rate: number): void {
    this.send({ type: 'SetPlaybackRate', payload: { rate } })
  }

  // --- Публичные геттеры и подписка ---

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
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
}
