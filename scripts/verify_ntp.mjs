// Ручная проверка TimeSync-обмена с реальным бэкендом.
// Эмулирует одного или двух клиентов, шлёт серию TimeSyncRequest и
// печатает offset, RTT, дрейф, uncertainty по тем же формулам, что и
// frontend/src/sync/clockMath.ts.
//
// Запуск (Node 22+, использует встроенный globalThis.WebSocket):
//   node scripts/verify_ntp.mjs
//
// Перед запуском поднять бэкенд:
//   cd backend && .venv/Scripts/python -m uvicorn app.main:app --port 8000

import { performance } from 'node:perf_hooks'

const URL = 'ws://localhost:8000/ws/demo'

// --- Точные копии формул из frontend/src/sync/clockMath.ts ---
const computeOffsetMs = (t0, t1, t2, t3) => ((t1 - t0) + (t2 - t3)) / 2
const computeRttMs = (t0, t1, t2, t3) => (t3 - t0) - (t2 - t1)

const median = (sorted) => {
  const n = sorted.length
  if (n === 0) return 0
  if (n % 2 === 1) return sorted[(n - 1) / 2]
  return (sorted[n / 2 - 1] + sorted[n / 2]) / 2
}

const selectBestOffset = (window, trimRatio) => {
  if (window.length === 0) return 0
  const sortedByRtt = [...window].sort((a, b) => a.rtt - b.rtt)
  const keepCount = Math.max(1, Math.ceil(sortedByRtt.length * (1 - trimRatio)))
  const kept = sortedByRtt.slice(0, keepCount)
  const offsets = kept.map((m) => m.offset).sort((a, b) => a - b)
  return median(offsets)
}

const offsetUncertaintyMs = (window) => {
  if (window.length === 0) return 0
  const rtts = window.map((m) => m.rtt)
  const minRtt = Math.min(...rtts)
  const sortedRtts = [...rtts].sort((a, b) => a - b)
  const medianRtt = median(sortedRtts)
  return Math.max(0, (medianRtt - minRtt) / 2)
}

// --- Эмуляция одного клиента ---
async function runClient(nickname, totalMeasurements = 8) {
  const ws = new WebSocket(URL)
  const window = []
  // Пошагово считаем итоговый offset после каждого измерения,
  // чтобы получить дрейф = offset_i - offset_1.
  const offsetHistory = []
  let resolveDone

  const done = new Promise((r) => (resolveDone = r))

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'Hello',
      payload: { session_id: 'demo', nickname },
    }))
  })

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.type === 'Welcome') {
      sendTimeSync()
    } else if (msg.type === 'TimeSyncResponse') {
      const t3 = performance.now()
      const { client_send_ms: t0, server_receive_ms: t1, server_send_ms: t2 } = msg.payload
      const m = {
        t0, t1, t2, t3,
        offset: computeOffsetMs(t0, t1, t2, t3),
        rtt: computeRttMs(t0, t1, t2, t3),
      }
      window.push(m)
      offsetHistory.push(selectBestOffset(window, 0.25))

      if (window.length >= totalMeasurements) {
        ws.close()
        resolveDone({ window, offsetHistory })
      } else {
        setTimeout(sendTimeSync, 200) // быстро для скрипта
      }
    } else if (msg.type === 'Error') {
      console.error(`[${nickname}] Error:`, msg.payload)
    }
  })

  function sendTimeSync() {
    const t0 = performance.now()
    ws.send(JSON.stringify({
      type: 'TimeSyncRequest',
      payload: { client_send_ms: t0 },
    }))
  }

  ws.addEventListener('error', (e) => console.error(`[${nickname}] WS error:`, e.message))

  return done
}

function report(nickname, window, offsetHistory) {
  const firstOffset = offsetHistory[0]
  console.log(`\n=== Клиент "${nickname}" — ${window.length} измерений ===`)
  console.log('  #  |   drift (мс)  |  rtt (мс)')
  console.log(' ----+---------------+-----------')
  window.forEach((m, i) => {
    const drift = offsetHistory[i] - firstOffset
    const d = drift.toFixed(3).padStart(13)
    const r = m.rtt.toFixed(3).padStart(9)
    console.log(`  ${String(i + 1).padStart(2)} | ${d} | ${r}`)
  })

  const finalOffset = offsetHistory[offsetHistory.length - 1]
  const finalDrift = finalOffset - firstOffset
  const uncertainty = offsetUncertaintyMs(window)
  const rtts = window.map((m) => m.rtt).sort((a, b) => a - b)
  const rttMedian = median(rtts)
  const rttMin = Math.min(...rtts)
  const lastRtt = window[window.length - 1].rtt

  console.log(`\n  итоговый drift: ${finalDrift.toFixed(3)} мс`)
  console.log(`  uncertainty:    ±${uncertainty.toFixed(3)} мс`)
  console.log(`  median RTT: ${rttMedian.toFixed(3)} мс | min RTT: ${rttMin.toFixed(3)} мс | last RTT: ${lastRtt.toFixed(3)} мс`)
  console.log(`  (offset для getServerTime: ${finalOffset.toFixed(3)} мс)`)

  return { finalOffset, finalDrift }
}

// --- Сценарий 1: один клиент ---
console.log('\n###############################################')
console.log('#  Сценарий 1: один клиент, 8 измерений      #')
console.log('###############################################')
const r1 = await runClient('verifier-1', 8)
const out1 = report('verifier-1', r1.window, r1.offsetHistory)

// --- Сценарий 2: два клиента параллельно ---
console.log('\n\n###############################################')
console.log('#  Сценарий 2: два клиента параллельно        #')
console.log('###############################################')
const [a, b] = await Promise.all([
  runClient('alice', 8),
  runClient('bob', 8),
])
const outA = report('alice', a.window, a.offsetHistory)
const outB = report('bob', b.window, b.offsetHistory)

console.log('\n=== Сравнение getServerTime() между alice и bob ===')
console.log(`  alice offset: ${outA.finalOffset.toFixed(3)} мс`)
console.log(`  bob   offset: ${outB.finalOffset.toFixed(3)} мс`)
console.log(`  |разница|:    ${Math.abs(outA.finalOffset - outB.finalOffset).toFixed(3)} мс`)
console.log('  (это и есть рассинхрон серверного времени между клиентами)\n')

process.exit(0)
