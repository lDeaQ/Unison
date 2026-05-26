import { describe, it, expect } from 'vitest'
import {
  computeOffsetMs,
  computeRttMs,
  makeMeasurement,
  median,
  selectBestOffset,
  offsetUncertaintyMs,
  type Measurement,
} from './clockMath'

// ---------- Базовая математика offset / rtt ----------

describe('computeOffsetMs / computeRttMs', () => {
  it('идеальная сеть, симметричная задержка → корректный offset и rtt', () => {
    // t0=0, сервер принял через 100мс, мгновенно ответил, клиент получил через 200мс
    // t1=100, t2=101, t3=200
    // offset = ((100-0) + (101-200)) / 2 = (100 - 99) / 2 = 0.5
    // rtt = (200-0) - (101-100) = 200 - 1 = 199
    expect(computeOffsetMs(0, 100, 101, 200)).toBe(0.5)
    expect(computeRttMs(0, 100, 101, 200)).toBe(199)
  })

  it('симметричная RTT=100мс, истинный offset=+500мс', () => {
    // Сервер впереди на 500мс. Сеть: 50мс туда + 50мс обратно. Обработка 0мс.
    // t0=0, t1=550 (server time = client_time + offset + 50ms one-way)
    // t2=550 (server отвечает мгновенно), t3=100 (client_time + 100ms full RT)
    // offset = ((550-0) + (550-100)) / 2 = (550+450)/2 = 500 ✓
    // rtt = (100-0) - (550-550) = 100 ✓
    expect(computeOffsetMs(0, 550, 550, 100)).toBe(500)
    expect(computeRttMs(0, 550, 550, 100)).toBe(100)
  })

  it('асимметричная задержка → искажает offset на половину разности задержек', () => {
    // Истинный offset=0. Сеть: 30мс туда, 70мс обратно (асимметрия +40мс в сторону обратной).
    // t0=0, t1=30 (30мс one-way к серверу), t2=30 (мгновенный ответ),
    // t3=100 (30мс туда + 70мс обратно).
    // offset_estimate = ((30-0) + (30-100))/2 = (30-70)/2 = -20
    // То есть смещён на -20 = -(70-30)/2 = -(асимметрия)/2 ✓
    expect(computeOffsetMs(0, 30, 30, 100)).toBe(-20)
    expect(computeRttMs(0, 30, 30, 100)).toBe(100)
  })

  it('makeMeasurement собирает Measurement с правильными offset и rtt', () => {
    const m = makeMeasurement(0, 100, 101, 200)
    expect(m).toEqual({
      t0: 0,
      t1: 100,
      t2: 101,
      t3: 200,
      offset: 0.5,
      rtt: 199,
    })
  })
})

// ---------- median ----------

describe('median', () => {
  it('нечётное количество', () => {
    expect(median([1, 2, 3])).toBe(2)
    expect(median([5])).toBe(5)
    expect(median([-10, 0, 10])).toBe(0)
  })

  it('чётное количество — среднее двух центральных', () => {
    expect(median([1, 2, 3, 4])).toBe(2.5)
    expect(median([0, 10])).toBe(5)
  })

  it('пустой массив → 0 по соглашению', () => {
    expect(median([])).toBe(0)
  })

  it('дубликаты и отрицательные значения', () => {
    expect(median([-5, -5, -5])).toBe(-5)
    expect(median([1, 1, 2, 2])).toBe(1.5)
  })
})

// ---------- selectBestOffset ----------

describe('selectBestOffset', () => {
  /** Хелпер: построить Measurement с заданными offset и rtt. */
  const m = (offset: number, rtt: number): Measurement => ({
    t0: 0,
    t1: offset + rtt / 2,
    t2: offset + rtt / 2,
    t3: rtt,
    offset,
    rtt,
  })

  it('пустое окно → 0', () => {
    expect(selectBestOffset([], 0.25)).toBe(0)
  })

  it('окно из 1 элемента → его offset', () => {
    expect(selectBestOffset([m(42, 100)], 0.25)).toBe(42)
  })

  it('окно из 4, trim=0.25 → сохраняем 3, медиана из 3', () => {
    // Сортировка по RTT: 10, 20, 30, 99 → keepCount = ceil(4*0.75) = 3
    // Оставляем: offsets [5, 10, 7] → отсортировано [5, 7, 10] → медиана = 7
    const window = [m(5, 10), m(10, 20), m(7, 30), m(500, 99)]
    expect(selectBestOffset(window, 0.25)).toBe(7)
  })

  it('отбрасывает 25% худших по RTT — выбросы не влияют на результат', () => {
    // 8 измерений: 6 хороших (offset ≈ 100, rtt ≈ 50) + 2 выброса (offset 500, rtt 500)
    // После сортировки по RTT отсекаем 2 верхних (ceil(8*0.25)=2) → выбросы выбрасываются.
    // Из 6 оставшихся медиана offset ≈ 100.
    const good = [
      m(98, 48),
      m(99, 49),
      m(100, 50),
      m(101, 51),
      m(102, 52),
      m(100, 53),
    ]
    const bad = [m(500, 480), m(-500, 500)]
    const window = [...good, ...bad]
    const result = selectBestOffset(window, 0.25)
    // Медиана из [98,99,100,100,101,102] = (100+100)/2 = 100
    expect(result).toBe(100)
  })

  it('медиана выбирается из оставшихся после trim корректно (чётное N)', () => {
    // 8 измерений, trim 25% → keep 6 (по RTT) → медиана = среднее 3-го и 4-го по offset
    const window = [
      m(10, 10), // keep
      m(20, 11), // keep
      m(30, 12), // keep
      m(40, 13), // keep
      m(50, 14), // keep
      m(60, 15), // keep
      m(999, 50), // trim
      m(-999, 60), // trim
    ]
    // Оставшиеся offsets: [10,20,30,40,50,60], медиана = (30+40)/2 = 35
    expect(selectBestOffset(window, 0.25)).toBe(35)
  })

  it('медиана из нечётного количества после trim', () => {
    // 5 измерений, trim 0.25 → keepCount = ceil(5*0.75) = 4 → нет, ceil(3.75) = 4
    // ждём медиану из 4 оставшихся
    const window = [m(1, 10), m(2, 11), m(3, 12), m(4, 13), m(999, 100)]
    // keep по RTT: [1,2,3,4] offsets, отсортировано [1,2,3,4], медиана (2+3)/2 = 2.5
    expect(selectBestOffset(window, 0.25)).toBe(2.5)
  })

  it('равные RTT — сортировка не падает, результат детерминирован', () => {
    // Все RTT одинаковы, trim ничего не отрежет (keep=8), медиана по всем offset
    const window = [
      m(1, 50), m(2, 50), m(3, 50), m(4, 50),
      m(5, 50), m(6, 50), m(7, 50), m(8, 50),
    ]
    // ceil(8*0.75)=6, оставляем 6 первых по RTT (сортировка стабильна) → offsets [1..6]
    // медиана (3+4)/2 = 3.5
    expect(selectBestOffset(window, 0.25)).toBe(3.5)
  })
})

// ---------- offsetUncertaintyMs ----------

describe('offsetUncertaintyMs', () => {
  const m = (offset: number, rtt: number): Measurement => ({
    t0: 0, t1: 0, t2: 0, t3: 0, offset, rtt,
  })

  it('пустое окно → 0', () => {
    expect(offsetUncertaintyMs([])).toBe(0)
  })

  it('одинаковые RTT → uncertainty = 0', () => {
    expect(offsetUncertaintyMs([m(0, 50), m(0, 50), m(0, 50)])).toBe(0)
  })

  it('formula: (medianRtt - minRtt) / 2', () => {
    // RTT: [10, 20, 30, 40, 50] → median=30, min=10 → uncertainty=(30-10)/2=10
    const window = [m(0, 10), m(0, 20), m(0, 30), m(0, 40), m(0, 50)]
    expect(offsetUncertaintyMs(window)).toBe(10)
  })

  it('никогда не отрицательная', () => {
    // искусственный случай — не должен возникнуть, но проверяем защиту
    expect(offsetUncertaintyMs([m(0, 100)])).toBe(0)
  })
})

// ---------- Stability under long run ----------

describe('stability under long run', () => {
  /** Seedable PRNG (mulberry32) — детерминированный тест. */
  function mulberry32(seed: number): () => number {
    let s = seed >>> 0
    return () => {
      s = (s + 0x6d2b79f5) >>> 0
      let t = s
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  /** Box-Muller: гауссовское N(mean, sd) из двух uniform(0,1). */
  function gaussian(rand: () => number, mean: number, sd: number): number {
    const u1 = Math.max(rand(), 1e-12)
    const u2 = rand()
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
    return mean + z * sd
  }

  /** Построить Measurement с заданными offset и rtt. */
  function makeM(offset: number, rtt: number): Measurement {
    return { t0: 0, t1: offset + rtt / 2, t2: offset + rtt / 2, t3: rtt, offset, rtt }
  }

  it('1000 измерений: трим+медиана удерживают offset в [85, 115]', () => {
    const TRUE_OFFSET = 100
    const NOISE_SD = 5
    const OUTLIER_RATE = 0.1
    const NORMAL_RTT_BASE = 50
    const WINDOW = 8
    const N = 1000

    const rand = mulberry32(42)
    const window: Measurement[] = []
    let checksRun = 0
    let outOfBounds = 0

    for (let i = 0; i < N; i++) {
      const isOutlier = rand() < OUTLIER_RATE

      let offset: number
      let rtt: number
      if (isOutlier) {
        // Выброс: RTT в 5–10× выше нормы, offset загрязнён ±500 мс
        rtt = NORMAL_RTT_BASE * (5 + 5 * rand())
        offset = TRUE_OFFSET + (rand() < 0.5 ? -500 : 500)
      } else {
        // Норма: гауссовский шум вокруг истинного offset, RTT слегка варьируется
        offset = gaussian(rand, TRUE_OFFSET, NOISE_SD)
        rtt = NORMAL_RTT_BASE + (rand() - 0.5) * 10 // [45, 55]
      }

      window.push(makeM(offset, rtt))
      if (window.length > WINDOW) window.shift()

      // Проверяем только когда окно заполнено — на неполном окне 1 выброс
      // не успевает быть отсечён триммингом, что не отражает реальную работу.
      if (window.length === WINDOW) {
        const estimate = selectBestOffset(window, 0.25)
        checksRun++
        if (estimate < 85 || estimate > 115) {
          outOfBounds++
        }
      }
    }

    // Должны были проверить 1000 - 8 + 1 = 993 раза.
    expect(checksRun).toBe(N - WINDOW + 1)
    // На детерминированном seed=42 ожидаем 0 промахов.
    // Тест ловит регрессии: если кто-то сломает trimming или медиану,
    // outOfBounds резко вырастет.
    expect(outOfBounds).toBe(0)
  })
})
