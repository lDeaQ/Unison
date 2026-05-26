import { describe, it, expect } from 'vitest'
import {
  computeCurrentPositionMs,
  applyPlay,
  applyPause,
  applySeek,
  applySetRate,
  serverMsToLocalPerfNow,
  type PlaybackState,
} from './playbackMath'

const state = (overrides: Partial<PlaybackState> = {}): PlaybackState => ({
  isPlaying: false,
  positionMs: 0,
  anchorPerfNowMs: 0,
  playbackRate: 1.0,
  videoUrl: '',
  ...overrides,
})

// ---------- computeCurrentPositionMs ----------

describe('computeCurrentPositionMs', () => {
  it('статика: is_playing=false → возвращает positionMs независимо от now', () => {
    const s = state({ isPlaying: false, positionMs: 5000, anchorPerfNowMs: 0 })
    expect(computeCurrentPositionMs(s, 99999)).toBe(5000)
    expect(computeCurrentPositionMs(s, 0)).toBe(5000)
  })

  it('динамика rate=1.0: positionMs=1000, anchor=10000, now=12000 → 3000', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 10000, playbackRate: 1.0 })
    expect(computeCurrentPositionMs(s, 12000)).toBe(3000)
  })

  it('динамика rate=2.0: positionMs=1000, anchor=10000, now=12000 → 5000', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 10000, playbackRate: 2.0 })
    expect(computeCurrentPositionMs(s, 12000)).toBe(5000)
  })

  it('динамика rate=0.5: positionMs=1000, anchor=10000, now=12000 → 2000', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 10000, playbackRate: 0.5 })
    expect(computeCurrentPositionMs(s, 12000)).toBe(2000)
  })

  it('Math.floor: дробный elapsed усекается вниз', () => {
    // elapsed = 100.9 → floor = 100, не 101
    const s = state({ isPlaying: true, positionMs: 0, anchorPerfNowMs: 0, playbackRate: 1.0 })
    expect(computeCurrentPositionMs(s, 100.9)).toBe(100)
  })
})

// ---------- applyPlay ----------

describe('applyPlay', () => {
  it('идемпотентность: is_playing=true → тот же объект', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 5000 })
    expect(applyPlay(s, 9999)).toBe(s)
  })

  it('переход из паузы: positionMs сохраняется, anchor=executeAt', () => {
    const s = state({ isPlaying: false, positionMs: 1000, anchorPerfNowMs: 0 })
    const s2 = applyPlay(s, 5000)
    expect(s2.isPlaying).toBe(true)
    expect(s2.positionMs).toBe(1000)
    expect(s2.anchorPerfNowMs).toBe(5000)
    expect(s2.playbackRate).toBe(s.playbackRate)
  })
})

// ---------- applyPause ----------

describe('applyPause', () => {
  it('идемпотентность: is_playing=false → тот же объект', () => {
    const s = state({ isPlaying: false, positionMs: 500 })
    expect(applyPause(s, 9999)).toBe(s)
  })

  it('фиксирует позицию на execute_at (rate=1.0): pos=1000, anchor=10000, exec=12000 → pos=3000', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 10000, playbackRate: 1.0 })
    const s2 = applyPause(s, 12000)
    expect(s2.isPlaying).toBe(false)
    expect(s2.positionMs).toBe(3000)
    expect(s2.anchorPerfNowMs).toBe(12000)
  })

  it('фиксирует позицию на execute_at (rate=2.0): pos=1000, anchor=10000, exec=12000 → pos=5000', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 10000, playbackRate: 2.0 })
    const s2 = applyPause(s, 12000)
    expect(s2.isPlaying).toBe(false)
    expect(s2.positionMs).toBe(5000)
  })
})

// ---------- applySeek ----------

describe('applySeek', () => {
  it('сохраняет isPlaying=true', () => {
    const s = state({ isPlaying: true, positionMs: 1000, anchorPerfNowMs: 10000 })
    const s2 = applySeek(s, 15000, 60000)
    expect(s2.isPlaying).toBe(true)
    expect(s2.positionMs).toBe(60000)
    expect(s2.anchorPerfNowMs).toBe(15000)
  })

  it('сохраняет isPlaying=false', () => {
    const s = state({ isPlaying: false, positionMs: 1000 })
    const s2 = applySeek(s, 15000, 60000)
    expect(s2.isPlaying).toBe(false)
    expect(s2.positionMs).toBe(60000)
  })

  it('сохраняет playbackRate', () => {
    const s = state({ isPlaying: true, playbackRate: 1.5, anchorPerfNowMs: 0 })
    const s2 = applySeek(s, 100, 500)
    expect(s2.playbackRate).toBe(1.5)
  })
})

// ---------- applySetRate ----------

describe('applySetRate', () => {
  it('сохраняет непрерывность: позиция на execute_at по СТАРОМУ rate', () => {
    // playing, pos=0, anchor=0, rate=1.0, exec=2000 → posAtExec=2000
    // новый rate=2.0, позиция не прыгает
    const s = state({ isPlaying: true, positionMs: 0, anchorPerfNowMs: 0, playbackRate: 1.0 })
    const s2 = applySetRate(s, 2000, 2.0)
    expect(s2.positionMs).toBe(2000)
    expect(s2.anchorPerfNowMs).toBe(2000)
    expect(s2.playbackRate).toBe(2.0)
    expect(s2.isPlaying).toBe(true)
  })

  it('сохраняет isPlaying при смене rate', () => {
    const playing = state({ isPlaying: true, positionMs: 0, anchorPerfNowMs: 0 })
    expect(applySetRate(playing, 1000, 0.5).isPlaying).toBe(true)

    const paused = state({ isPlaying: false, positionMs: 500 })
    expect(applySetRate(paused, 1000, 2.0).isPlaying).toBe(false)
  })

  it('для paused state positionAtExec = positionMs (elapsed=0 по is_playing=false)', () => {
    const s = state({ isPlaying: false, positionMs: 3000, anchorPerfNowMs: 0 })
    const s2 = applySetRate(s, 5000, 2.0)
    expect(s2.positionMs).toBe(3000)
  })
})

// ---------- Композиция Play → SetRate(2.0) → Pause → Seek ----------

describe('композиция команд', () => {
  it('Play → SetRate(2.0) → Pause → Seek: итоговое состояние корректно', () => {
    let s = state({ isPlaying: false, positionMs: 0, anchorPerfNowMs: 0, playbackRate: 1.0 })

    // Play в t=1000: anchor=1000, rate=1.0, pos=0
    s = applyPlay(s, 1000)
    expect(s.isPlaying).toBe(true)

    // SetRate(2.0) в t=3000: posAtExec = 0 + floor((3000-1000)*1.0) = 2000
    s = applySetRate(s, 3000, 2.0)
    expect(s.positionMs).toBe(2000)
    expect(s.playbackRate).toBe(2.0)

    // Pause в t=4000: posAtPause = 2000 + floor((4000-3000)*2.0) = 4000
    s = applyPause(s, 4000)
    expect(s.isPlaying).toBe(false)
    expect(s.positionMs).toBe(4000)

    // Seek to 5000 в t=5000
    s = applySeek(s, 5000, 5000)
    expect(s.positionMs).toBe(5000)

    // Проверяем: paused, computeCurrentPositionMs не меняется
    expect(computeCurrentPositionMs(s, 6000)).toBe(5000)
  })
})

// ---------- serverMsToLocalPerfNow ----------

describe('serverMsToLocalPerfNow', () => {
  it('арифметика: server=1716890001200, offset=1716890001000 → local=200', () => {
    expect(serverMsToLocalPerfNow(1716890001200, 1716890001000)).toBe(200)
  })

  it('offset=0: serverMs передаётся как есть', () => {
    expect(serverMsToLocalPerfNow(12345, 0)).toBe(12345)
  })
})

// ---------- Late-command сценарий ----------

describe('late-command Play', () => {
  it('bродкаст -300мс назад: позиция компенсируется автоматически через anchor', () => {
    const nowInTest = 10000
    const executeAt = nowInTest - 300  // 9700 — команда «из прошлого»

    const s = state({ isPlaying: false, positionMs: 1000, playbackRate: 1.0 })
    const s2 = applyPlay(s, executeAt)

    // anchor=9700, теперь = 10000 → elapsed=300, pos=1000+300=1300
    const position = computeCurrentPositionMs(s2, nowInTest)
    expect(position).toBe(1300)
  })

  it('late Play с rate=2.0: позиция=1000+300*2=1600', () => {
    const nowInTest = 10000
    const executeAt = 9700

    const s = state({ isPlaying: false, positionMs: 1000, playbackRate: 2.0 })
    const s2 = applyPlay(s, executeAt)
    expect(computeCurrentPositionMs(s2, nowInTest)).toBe(1600)
  })
})
