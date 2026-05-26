import { useEffect, useState } from 'react'
import type { ClockSync } from './ClockSync'

export interface ClockSyncState {
  offset: number
  drift: number
  lastRtt: number
  rttMedian: number
  uncertainty: number
  measurementCount: number
  isReady: boolean
}

const EMPTY: ClockSyncState = {
  offset: 0,
  drift: 0,
  lastRtt: 0,
  rttMedian: 0,
  uncertainty: 0,
  measurementCount: 0,
  isReady: false,
}

/**
 * Подписка на обновления ClockSync с реактивным перерисовыванием React.
 * Сам класс ClockSync остаётся вне React-мира — этот хук только мост.
 */
export function useClockSync(clock: ClockSync | null): ClockSyncState {
  const [state, setState] = useState<ClockSyncState>(EMPTY)

  useEffect(() => {
    if (!clock) {
      setState(EMPTY)
      return
    }

    const update = () => {
      setState({
        offset: clock.getOffset(),
        drift: clock.getOffsetDriftMs(),
        lastRtt: clock.getLastRtt(),
        rttMedian: clock.getRtt(),
        uncertainty: clock.getOffsetUncertaintyMs(),
        measurementCount: clock.getMeasurementCount(),
        isReady: clock.isReady(),
      })
    }

    clock.on('updated', update)
    // Первый снимок — на случай если ClockSync уже накопил измерения
    // до момента, когда хук успел подписаться.
    update()

    return () => {
      clock.off('updated', update)
    }
  }, [clock])

  return state
}
