import { useState, useEffect } from 'react'
import type { PlaybackSync } from './PlaybackSync'

export interface PlaybackHookState {
  isPlaying: boolean
  positionMs: number   // live: обновляется каждые 100мс при воспроизведении
  playbackRate: number
  videoUrl: string
}

const noop = () => {}
const noopSeek = (_ms: number) => {}
const noopRate = (_r: number) => {}

export function usePlayback(sync: PlaybackSync | null): {
  state: PlaybackHookState
  play: () => void
  pause: () => void
  seek: (positionMs: number) => void
  setRate: (rate: number) => void
} {
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!sync) return

    const unsub = sync.onChange(() => setTick((t) => t + 1))

    // 100мс достаточно для глаза; requestAnimationFrame избыточен для текстового индикатора
    const interval = setInterval(() => {
      if (sync.getState().isPlaying) setTick((t) => t + 1)
    }, 100)

    return () => {
      unsub()
      clearInterval(interval)
    }
  }, [sync])

  if (!sync) {
    return {
      state: { isPlaying: false, positionMs: 0, playbackRate: 1, videoUrl: '' },
      play: noop,
      pause: noop,
      seek: noopSeek,
      setRate: noopRate,
    }
  }

  const s = sync.getState()
  // Приоритет — реальная позиция из плеера (обходит задержку буферизации).
  // Fallback на math-модель: когда адаптер ещё не дал ни одного timeupdate.
  const adapterPos = sync.getAdapterPositionMs()
  const positionMs = adapterPos !== null ? adapterPos : sync.currentPositionMs()
  return {
    state: {
      isPlaying: s.isPlaying,
      positionMs,
      playbackRate: s.playbackRate,
      videoUrl: s.videoUrl,
    },
    play:    () => sync.requestPlay(),
    pause:   () => sync.requestPause(),
    seek:    (ms) => sync.requestSeek(ms),
    setRate: (r) => sync.requestSetRate(r),
  }
}
