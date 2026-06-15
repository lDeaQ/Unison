export type PlayerEvent = 'play' | 'pause' | 'seek' | 'timeupdate' | 'ready' | 'error' | 'ended'

export interface IPlayerAdapter {
  // Управление воспроизведением
  play(): Promise<void>
  pause(): Promise<void>
  seek(seconds: number): Promise<void>
  setPlaybackRate(rate: number): Promise<void>

  // Состояние
  getCurrentTime(): Promise<number>
  getDuration(): Promise<number>
  isReady(): boolean

  // События
  on(event: PlayerEvent, cb: (...args: unknown[]) => void): void
  off(event: PlayerEvent, cb: (...args: unknown[]) => void): void

  // Жизненный цикл
  destroy(): void
}

// Базовый класс с общей реализацией подписки/отписки
export abstract class BasePlayerAdapter implements IPlayerAdapter {
  protected listeners: Map<PlayerEvent, Set<(...args: unknown[]) => void>> = new Map()

  on(event: PlayerEvent, cb: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(cb)
  }

  off(event: PlayerEvent, cb: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(cb)
  }

  protected emit(event: PlayerEvent, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((cb) => cb(...args))
  }

  abstract play(): Promise<void>
  abstract pause(): Promise<void>
  abstract seek(seconds: number): Promise<void>
  abstract setPlaybackRate(rate: number): Promise<void>
  abstract getCurrentTime(): Promise<number>
  abstract getDuration(): Promise<number>
  abstract isReady(): boolean
  abstract destroy(): void
}
