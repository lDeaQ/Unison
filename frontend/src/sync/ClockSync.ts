import type {
  ClientMessage,
  TimeSyncResponsePayload,
} from '../types/protocol'
import {
  makeMeasurement,
  median,
  offsetUncertaintyMs,
  selectBestOffset,
  type Measurement,
} from './clockMath'

type SendFn = (msg: ClientMessage) => void
type ClockSyncEvent = 'updated'

export interface ClockSyncOptions {
  windowSize?: number        // окно последних измерений, по умолчанию 8
  trimRatio?: number         // доля худших по RTT для отсечения, по умолчанию 0.25
  warmupCount?: number       // сколько измерений делать в стартовой фазе
  warmupIntervalMs?: number  // интервал в стартовой фазе
  steadyIntervalMs?: number  // интервал в установившемся режиме
}

const DEFAULTS: Required<ClockSyncOptions> = {
  windowSize: 8,
  trimRatio: 0.25,
  warmupCount: 5,
  warmupIntervalMs: 1000,
  steadyIntervalMs: 5000,
}

/**
 * NTP-подобная синхронизация клиентских часов с серверными.
 *
 * Внешний код:
 *   - даёт send-callback в конструктор,
 *   - вызывает start() при 'connected', stop() при разрыве,
 *   - вызывает handleResponse(payload) при получении TimeSyncResponse,
 *   - читает offset/rtt/uncertainty/count через геттеры или подписку на 'updated'.
 *
 * Класс не знает про WSClient, React и DOM — только про абстрактный send
 * и про performance.now(). Это даёт чистую тестируемость и переиспользуемость.
 */
export class ClockSync {
  private readonly windowSize: number
  private readonly trimRatio: number
  private readonly warmupCount: number
  private readonly warmupIntervalMs: number
  private readonly steadyIntervalMs: number

  private window: Measurement[] = []
  private offset = 0
  // firstOffset фиксируется при первом успешном измерении и не меняется
  // до следующего reset(). По нему считается дрейф — изменение offset
  // относительно стартовой оценки, наглядная метрика для UI и для оценки
  // стабильности часов в долгом сеансе.
  private firstOffset: number | null = null
  private rttMedian = 0
  private lastRtt = 0
  private uncertainty = 0
  private measurementCount = 0

  private running = false
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private readonly listeners: Map<ClockSyncEvent, Set<() => void>> = new Map()
  private readonly send: SendFn

  constructor(send: SendFn, options: ClockSyncOptions = {}) {
    this.send = send
    this.windowSize = options.windowSize ?? DEFAULTS.windowSize
    this.trimRatio = options.trimRatio ?? DEFAULTS.trimRatio
    this.warmupCount = options.warmupCount ?? DEFAULTS.warmupCount
    this.warmupIntervalMs = options.warmupIntervalMs ?? DEFAULTS.warmupIntervalMs
    this.steadyIntervalMs = options.steadyIntervalMs ?? DEFAULTS.steadyIntervalMs
  }

  // ---------- Управление жизненным циклом ----------

  start(): void {
    if (this.running) return
    this.running = true
    // Первый запрос — почти сразу (0 мс), чтобы UI быстро получил первое значение.
    this.scheduleNext(0)
  }

  stop(): void {
    this.running = false
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * Жёсткий сброс: окно пустое, счётчик измерений в 0, warmup запускается заново.
   * Предполагаемый вызов: stop() → reset() → start() на реконнекте.
   *
   * TODO (этап полировки UX): мягкий сброс при быстром реконнекте (< 60 сек
   * с последнего измерения) — сохранять offset как стартовое значение,
   * пропускать warmup. См. docs/plan_ntp.md §9.
   */
  reset(): void {
    this.window = []
    this.offset = 0
    this.firstOffset = null
    this.rttMedian = 0
    this.lastRtt = 0
    this.uncertainty = 0
    this.measurementCount = 0
  }

  // ---------- Обработка входящих ответов ----------

  handleResponse(payload: TimeSyncResponsePayload): void {
    // Защита от гонок: stop() мог быть вызван между отправкой запроса
    // и приходом ответа. Если так — выбрасываем измерение, оно от
    // «прошлой жизни» соединения.
    if (!this.running) return

    const t3 = performance.now()
    const m = makeMeasurement(
      payload.client_send_ms,
      payload.server_receive_ms,
      payload.server_send_ms,
      t3,
    )

    this.window.push(m)
    if (this.window.length > this.windowSize) this.window.shift()

    this.offset = selectBestOffset(this.window, this.trimRatio)
    if (this.firstOffset === null) {
      this.firstOffset = this.offset
    }
    this.lastRtt = m.rtt
    const sortedRtts = this.window.map((x) => x.rtt).sort((a, b) => a - b)
    this.rttMedian = median(sortedRtts)
    this.uncertainty = offsetUncertaintyMs(this.window)
    this.measurementCount++

    this.emit('updated')
  }

  // ---------- Публичные геттеры ----------

  /** Текущее серверное время в той же шкале, что performance.now() + offset. */
  getServerTime(): number {
    return performance.now() + this.offset
  }

  getOffset(): number {
    if (this.window.length === 0) {
      // Fallback до первого измерения: грубая оценка через Date.now().
      // Погрешность ≈ RTT/2 (единицы мс на localhost) — приемлемо для scheduleApply.
      return Date.now() - performance.now()
    }
    return this.offset
  }

  /**
   * Дрейф offset относительно первого измерения.
   * Это та метрика, которую имеет смысл показывать пользователю: сам offset
   * — это огромное число вида (wall_clock_ms - performance.now()), порядка
   * 1.7e12, его дельта на единицах миллисекунд глазами не видна. Дрейф —
   * та же информация, но в наглядной шкале: 0 при первом измерении,
   * растёт по абсолютной величине, если часы клиента и сервера расходятся.
   */
  getOffsetDriftMs(): number {
    if (this.firstOffset === null) return 0
    return this.offset - this.firstOffset
  }

  /** Медиана RTT окна — используется в расчётах (uncertainty). */
  getRtt(): number {
    return this.rttMedian
  }

  /** RTT последнего измерения — для UI, чтобы видеть скачки сети. */
  getLastRtt(): number {
    return this.lastRtt
  }

  /** Верхняя оценка погрешности offset: (medianRtt - minRtt) / 2. */
  getOffsetUncertaintyMs(): number {
    return this.uncertainty
  }

  getMeasurementCount(): number {
    return this.measurementCount
  }

  isReady(): boolean {
    return this.measurementCount > 0
  }

  // ---------- Подписка ----------

  on(event: ClockSyncEvent, cb: () => void): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(cb)
  }

  off(event: ClockSyncEvent, cb: () => void): void {
    this.listeners.get(event)?.delete(cb)
  }

  private emit(event: ClockSyncEvent): void {
    this.listeners.get(event)?.forEach((cb) => cb())
  }

  // ---------- Внутренний цикл опроса ----------

  private scheduleNext(delayMs: number): void {
    this.pollTimer = setTimeout(() => this.tick(), delayMs)
  }

  private tick(): void {
    if (!this.running) return

    const t0 = performance.now()
    this.send({ type: 'TimeSyncRequest', payload: { client_send_ms: t0 } })

    // Фаза warmup определяется по числу УСПЕШНЫХ измерений, а не отправок:
    // если ответы теряются, держим короткий интервал, пока окно не наполнится.
    const nextInterval =
      this.measurementCount < this.warmupCount
        ? this.warmupIntervalMs
        : this.steadyIntervalMs
    this.scheduleNext(nextInterval)
  }
}
