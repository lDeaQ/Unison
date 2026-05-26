export interface PlaybackState {
  isPlaying: boolean
  positionMs: number       // позиция, зафиксированная в anchorPerfNowMs
  anchorPerfNowMs: number  // момент фиксации в шкале performance.now()
  playbackRate: number
  videoUrl: string
}

export function computeCurrentPositionMs(state: PlaybackState, nowPerfNowMs: number): number {
  if (!state.isPlaying) return state.positionMs
  const elapsedMs = (nowPerfNowMs - state.anchorPerfNowMs) * state.playbackRate
  return state.positionMs + Math.floor(elapsedMs)
}

export function applyPlay(state: PlaybackState, executeAtPerfNow: number): PlaybackState {
  if (state.isPlaying) return state
  return {
    isPlaying: true,
    positionMs: state.positionMs,
    anchorPerfNowMs: executeAtPerfNow,
    playbackRate: state.playbackRate,
    videoUrl: state.videoUrl,
  }
}

export function applyPause(state: PlaybackState, executeAtPerfNow: number): PlaybackState {
  if (!state.isPlaying) return state
  const positionAtExec = state.positionMs + Math.floor(
    (executeAtPerfNow - state.anchorPerfNowMs) * state.playbackRate,
  )
  return {
    isPlaying: false,
    positionMs: positionAtExec,
    anchorPerfNowMs: executeAtPerfNow,
    playbackRate: state.playbackRate,
    videoUrl: state.videoUrl,
  }
}

export function applySeek(
  state: PlaybackState,
  executeAtPerfNow: number,
  newPositionMs: number,
): PlaybackState {
  return {
    isPlaying: state.isPlaying,
    positionMs: newPositionMs,
    anchorPerfNowMs: executeAtPerfNow,
    playbackRate: state.playbackRate,
    videoUrl: state.videoUrl,
  }
}

export function applySetRate(
  state: PlaybackState,
  executeAtPerfNow: number,
  newRate: number,
): PlaybackState {
  const positionAtExec = computeCurrentPositionMs(state, executeAtPerfNow)
  return {
    isPlaying: state.isPlaying,
    positionMs: positionAtExec,
    anchorPerfNowMs: executeAtPerfNow,
    playbackRate: newRate,
    videoUrl: state.videoUrl,
  }
}

/**
 * Пересчёт execute_at (серверный Unix ms) в локальное performance.now()-время.
 * ClockSync определяет offset так: perfNow + offset = serverWallMs,
 * значит localPerfNow = serverMs - offset.
 */
export function serverMsToLocalPerfNow(serverMs: number, clockOffsetMs: number): number {
  return serverMs - clockOffsetMs
}
