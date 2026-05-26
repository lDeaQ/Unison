/**
 * Чистая математика NTP-подобной синхронизации часов.
 *
 * Этот модуль НЕ зависит от таймеров, сети, performance.now() и т. п. —
 * только функции преобразования чисел. Это даёт детерминированную
 * тестируемость: clockMath.test.ts проверяет всю расчётную логику без
 * моков сети и таймеров.
 */

export interface Measurement {
  t0: number // client_send_ms (performance.now() в момент отправки)
  t1: number // server_receive_ms
  t2: number // server_send_ms
  t3: number // client_receive_ms (performance.now() при приёме ответа)
  offset: number // считается при создании
  rtt: number // считается при создании
}

/**
 * Классическая формула NTP-смещения часов:
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *
 * Геометрический смысл: если предположить, что задержка туда и обратно
 * одинаковая, серверное время в момент середины интервала [t0, t3] равно
 * среднему между t1 и t2. Отсюда offset — разница между этим серверным
 * временем и клиентским средним.
 *
 * Метод систематически ошибается при асимметрии задержек: если put-leg
 * быстрее get-leg на dt, оценка offset смещена на dt/2 в сторону get-leg.
 * Эту ошибку нельзя устранить алгоритмически без дополнительной информации
 * о пути; она ограничивается выбором измерений с минимальным RTT.
 */
export function computeOffsetMs(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): number {
  return ((t1 - t0) + (t2 - t3)) / 2
}

/**
 * RTT — суммарная задержка туда-обратно без времени, потраченного сервером
 * на обработку:
 *   rtt = (t3 - t0) - (t2 - t1)
 *
 * (t3 - t0) — полное время цикла на клиенте, (t2 - t1) — обработка на сервере.
 */
export function computeRttMs(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): number {
  return (t3 - t0) - (t2 - t1)
}

export function makeMeasurement(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): Measurement {
  return {
    t0,
    t1,
    t2,
    t3,
    offset: computeOffsetMs(t0, t1, t2, t3),
    rtt: computeRttMs(t0, t1, t2, t3),
  }
}

/**
 * Медиана отсортированного массива чисел.
 * Для пустого массива возвращает 0 (соглашение — отсутствие данных = "нуль").
 */
export function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  if (n % 2 === 1) return sorted[(n - 1) / 2]
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

/**
 * Робастная оценка offset из окна измерений:
 *   1) сортируем по RTT по возрастанию,
 *   2) отбрасываем долю trimRatio с самым большим RTT,
 *   3) из оставшихся берём медиану offset.
 *
 * Отсекаем только верх по RTT: измерения с малым RTT — самые точные
 * (ошибка offset ограничена ±(rtt - rtt_min)/2 в предположении симметрии).
 * Симметричное отсечение выбросило бы как раз лучшие точки.
 */
export function selectBestOffset(
  window: Measurement[],
  trimRatio: number,
): number {
  if (window.length === 0) return 0
  const sortedByRtt = [...window].sort((a, b) => a.rtt - b.rtt)
  const keepCount = Math.max(1, Math.ceil(sortedByRtt.length * (1 - trimRatio)))
  const kept = sortedByRtt.slice(0, keepCount)
  const offsets = kept.map((m) => m.offset).sort((a, b) => a - b)
  return median(offsets)
}

/**
 * Верхняя оценка погрешности offset для окна:
 *   uncertainty = (medianRtt - minRtt) / 2
 *
 * Обоснование: в худшем случае асимметричной задержки ошибка equals
 * половине разницы между RTT текущего измерения и RTT идеального
 * (симметричного, минимального). Используя медианный RTT как
 * представителя «типичного» измерения и минимальный RTT окна как
 * приближение к "идеальному пути", получаем измеримую верхнюю границу.
 *
 * Эта метрика — наглядный показатель «насколько мы уверены»: ±5 мс
 * означает, что наш offset вряд ли промахнётся больше чем на 5 мс
 * относительно истинного.
 */
export function offsetUncertaintyMs(window: Measurement[]): number {
  if (window.length === 0) return 0
  const rtts = window.map((m) => m.rtt)
  const minRtt = Math.min(...rtts)
  const sortedRtts = [...rtts].sort((a, b) => a - b)
  const medianRtt = median(sortedRtts)
  return Math.max(0, (medianRtt - minRtt) / 2)
}
