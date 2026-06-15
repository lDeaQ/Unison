# План: команды Play / Pause / Seek / SetPlaybackRate с `execute_at`

## 1. Цель

Реализовать серверно-авторитетную модель воспроизведения. После этого этапа любое действие пользователя (Play / Pause / Seek / SetPlaybackRate) проходит через сервер и применяется на всех клиентах одновременно за счёт компенсации задержки через поле `execute_at`. Целевой рассинхрон между двумя клиентами в стационарном режиме — ≤ 150 мс, верхняя граница ≤ 400 мс (требования ТЗ).

Реальные адаптеры плееров (RuTube, VK Video) — следующая итерация. Сейчас на клиенте — **виртуальный плеер**: чистое состояние `{ is_playing, position_ms, playback_rate }`, отрисовываемое в UI; «позиция» движется во времени по формуле, без реального видео. Это позволяет отладить ядро синхронизации в изоляции от особенностей сторонних iframe API.

Опираемся на уже готовые блоки:
- `ClockSync` (фронт) даёт `getOffset()` и `getServerTime()` с субмиллисекундной точностью на localhost и измеримой uncertainty в реальной сети.
- `server_now_ms()` (бэк) — единая точка серверного времени.
- `ConnectionManager` (бэк) — рассылка `broadcast(session_id, json)` всем участникам.

---

## 2. Бэкенд

### 2.1 Серверное состояние сессии: `app/services/session_state.py`

Это новый модуль (директория `app/services/` пока пустая — см. CLAUDE.md, раздел «Структура»). Содержит чистую модель состояния воспроизведения и thread-safe-достаточный store для процесса uvicorn.

```python
from __future__ import annotations
from dataclasses import dataclass, field

@dataclass
class SessionState:
    """Состояние воспроизведения в сессии.

    Состояние полностью определяется тройкой (position_ms, anchor_server_ms,
    is_playing) + playback_rate. В любой момент серверного времени `now_ms`
    текущая позиция вычисляется детерминированно. Между командами никакие
    рассылки не нужны — клиенты сами знают, куда «уехала» позиция.
    """
    is_playing: bool = False
    position_ms: int = 0                # позиция, зафиксированная в anchor_server_ms
    anchor_server_ms: float = 0.0       # серверное время фиксации (Unix ms, float)
    playback_rate: float = 1.0
    video_url: str = ""


def compute_current_position_ms(state: SessionState, now_ms: float) -> int:
    """Текущая позиция воспроизведения на момент now_ms (серверное время)."""
    if not state.is_playing:
        return state.position_ms
    elapsed_ms = (now_ms - state.anchor_server_ms) * state.playback_rate
    return state.position_ms + int(elapsed_ms)


# --- Применение команд (чистые функции, возвращают новый state) ---

def apply_play(state: SessionState, execute_at_ms: float) -> SessionState:
    """Запуск воспроизведения. Идемпотентно при is_playing=True (возвращает as-is)."""
    if state.is_playing:
        return state
    return SessionState(
        is_playing=True,
        position_ms=state.position_ms,        # позиция не меняется, играть будем с неё
        anchor_server_ms=execute_at_ms,        # anchor = момент реального старта
        playback_rate=state.playback_rate,
        video_url=state.video_url,
    )

def apply_pause(state: SessionState, execute_at_ms: float) -> SessionState:
    """Постановка на паузу. Идемпотентно при is_playing=False."""
    if not state.is_playing:
        return state
    position_at_exec = state.position_ms + int(
        (execute_at_ms - state.anchor_server_ms) * state.playback_rate
    )
    return SessionState(
        is_playing=False,
        position_ms=position_at_exec,
        anchor_server_ms=execute_at_ms,
        playback_rate=state.playback_rate,
        video_url=state.video_url,
    )

def apply_seek(state: SessionState, execute_at_ms: float, new_position_ms: int) -> SessionState:
    """Перемотка. Состояние is_playing не меняется. Всегда «применяется» — это явный жест."""
    return SessionState(
        is_playing=state.is_playing,
        position_ms=new_position_ms,
        anchor_server_ms=execute_at_ms,
        playback_rate=state.playback_rate,
        video_url=state.video_url,
    )

def apply_set_rate(state: SessionState, execute_at_ms: float, new_rate: float) -> SessionState:
    """Смена скорости. Сохраняет непрерывность позиции:
       во время execute_at позиция вычисляется по СТАРОМУ rate и фиксируется как новый anchor.
    """
    position_at_exec = compute_current_position_ms(state, execute_at_ms)
    return SessionState(
        is_playing=state.is_playing,
        position_ms=position_at_exec,
        anchor_server_ms=execute_at_ms,
        playback_rate=new_rate,
        video_url=state.video_url,
    )


# --- Store ---

class SessionStateStore:
    """Хранит SessionState per session_id. Создаёт при первом обращении.

    Никакого asyncio.Lock не нужно: uvicorn в один процесс — single-threaded event loop,
    апдейт state выглядит как атомарная последовательность инструкций между awaitами.
    """
    def __init__(self) -> None:
        self._states: dict[str, SessionState] = {}

    def get_or_create(self, session_id: str) -> SessionState:
        st = self._states.get(session_id)
        if st is None:
            st = SessionState()
            self._states[session_id] = st
        return st

    def set(self, session_id: str, new_state: SessionState) -> None:
        self._states[session_id] = new_state

    def drop(self, session_id: str) -> None:
        self._states.pop(session_id, None)


state_store = SessionStateStore()
```

**Жизненный цикл state.** Создаётся лениво в обработчике (`get_or_create` при первом Hello) и удаляется в `ConnectionManager.disconnect`, когда сессия становится пустой (на месте «Сессия закрыта (все участники ушли)» в `manager.py`). Альтернатива «хранить state и после ухода всех» отвергнута: при перезаходе с тем же session_id это вызовет неожиданное поведение «комната помнит, что ты смотрел». Для диплома проще: пустая сессия = удалённая.

### 2.2 Константа задержки `EXECUTE_AT_DELAY_MS`

В `app/sync/clock.py` добавить:

```python
EXECUTE_AT_DELAY_MS = 200.0
```

Используется во всех точках формирования команд: `execute_at = server_now_ms() + EXECUTE_AT_DELAY_MS`. Обоснование значения 200 — раздел 5.1.

### 2.3 Схемы сообщений (`app/schemas/messages.py`)

#### Входящие (client → server)

```python
class PlayRequestPayload(BaseModel):
    position_ms: int = Field(ge=0)  # подсказка клиента; сервер использует свой anchor

class PlayRequestMessage(BaseModel):
    type: Literal["Play"]
    payload: PlayRequestPayload


class PauseRequestPayload(BaseModel):
    position_ms: int = Field(ge=0)

class PauseRequestMessage(BaseModel):
    type: Literal["Pause"]
    payload: PauseRequestPayload


class SeekRequestPayload(BaseModel):
    position_ms: int = Field(ge=0)

class SeekRequestMessage(BaseModel):
    type: Literal["Seek"]
    payload: SeekRequestPayload


_ALLOWED_RATES = {0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0}

class SetPlaybackRateRequestPayload(BaseModel):
    rate: float

    @field_validator("rate")
    @classmethod
    def _rate_must_be_allowed(cls, v: float) -> float:
        if v not in _ALLOWED_RATES:
            raise ValueError(f"rate {v} не в списке разрешённых: {sorted(_ALLOWED_RATES)}")
        return v

class SetPlaybackRateRequestMessage(BaseModel):
    type: Literal["SetPlaybackRate"]
    payload: SetPlaybackRateRequestPayload
```

Решение про **`position_ms` в Play / Pause-запросе**. Клиент шлёт свою оценку позиции, но **сервер её не использует** для формирования широковещания (берёт из своего state). Зачем тогда передавать? Два повода:
1. **Дебаг / события в логи.** Когда позднее появится `events_log`, разность `client_position − server_position` — отличный сигнал «у клиента дрейфует state, надо переусредниться».
2. **Будущая защита от рассинхрона.** Если `|client_position − server_position| > 1000 мс`, сервер может включить «Seek to server_position» перед Play — мы будем знать, что произошло.

Сейчас поле принимается, валидируется (`ge=0`) и игнорируется в логике. В логе INFO выводим оба числа для диагностики.

#### Исходящие (server → broadcast)

```python
class PlayBroadcastPayload(BaseModel):
    position_ms: int
    server_timestamp_ms: float
    execute_at_ms: float

class PlayBroadcastMessage(BaseModel):
    type: Literal["Play"] = "Play"
    payload: PlayBroadcastPayload

# Pause / Seek — структурно идентичны Play, отдельные классы для строгости.

class SetPlaybackRateBroadcastPayload(BaseModel):
    rate: float
    position_ms: int                  # позиция на момент execute_at — см. §5.6
    server_timestamp_ms: float
    execute_at_ms: float

class SetPlaybackRateBroadcastMessage(BaseModel):
    type: Literal["SetPlaybackRate"] = "SetPlaybackRate"
    payload: SetPlaybackRateBroadcastPayload
```

**Расширение `docs/protocol.md`:**
- В исходящих Play / Pause / Seek поля `server_timestamp` / `execute_at` переименовать в `server_timestamp_ms` / `execute_at_ms` (единый стиль с TimeSync-полями `client_send_ms`, `server_receive_ms`).
- В исходящий `SetPlaybackRate` добавить `position_ms`. Это **намеренное расширение протокола**, обоснование в §5.6.
- Заметка о расхождении со старым черновиком протокола вынесена в раздел §8 этого плана.

#### Расширение Welcome

```python
class WelcomePayload(BaseModel):
    ...                       # уже есть
    server_time_ms: float     # серверное время отправки Welcome (новое поле)
```

Поле используется в `PlaybackSync.onWelcome` для корректировки anchor при `is_playing=true`, если ClockSync уже выдал хотя бы одно измерение offset (`isReady() === true`). Если ClockSync ещё не готов на момент Welcome (вероятный кейс при первом подключении — он стартует после `connected`, т.е. сразу ПОСЛЕ Welcome) — используется fallback `performance.now()` с `console.info` о возможной погрешности ≈ RTT/2. Детали — §3.4.

### 2.4 Обработчик `ws/handler.py`

Внутри `while True`, после ветки `if msg_type == "TimeSyncRequest"`, добавить ветки на четыре команды. Шаблон един, отличия — какая чистая функция применяется и какая схема рассылается.

```python
# Пример для Play (Pause/Seek — аналогично):
if msg_type == "Play":
    try:
        req = PlayRequestMessage.model_validate(parsed)
    except ValidationError:
        await websocket.send_text(_make_error("INVALID_MESSAGE",
            "Play: ожидается payload.position_ms (int, ≥0)"))
        continue

    server_now = server_now_ms()
    execute_at = server_now + EXECUTE_AT_DELAY_MS

    old_state = state_store.get_or_create(session_id)
    new_state = apply_play(old_state, execute_at)

    if new_state is old_state:
        # Идемпотентный no-op (уже играли). Не рассылаем, чтобы не дёргать плееры.
        logger.info("Play (no-op, уже воспроизводится)", extra=log_extra)
        continue

    state_store.set(session_id, new_state)

    broadcast_msg = PlayBroadcastMessage(payload=PlayBroadcastPayload(
        position_ms=new_state.position_ms,
        server_timestamp_ms=server_now,
        execute_at_ms=execute_at,
    ))
    await manager.broadcast(session_id, broadcast_msg.model_dump_json())
    logger.info(
        "Play: client_pos=%d server_pos=%d execute_at=%.1f",
        req.payload.position_ms, new_state.position_ms, execute_at,
        extra=log_extra,
    )
    continue
```

**Идемпотентность:** для Play/Pause — `if new_state is old_state: continue` (не рассылаем). Для Seek и SetPlaybackRate — всегда рассылаем (даже на тот же rate/position): пользователь явно сделал действие, скрывать его нельзя (это может быть сознательная пересинхронизация — см. §5.3).

**Валидация rate в SetPlaybackRate** уже выполнится в Pydantic-валидаторе. На `ValidationError` шлём Error с `INVALID_MESSAGE` (и пояснением про список разрешённых rate), соединение не закрываем.

### 2.5 Welcome с актуальной позицией

В блоке формирования Welcome (`handler.py`, строки 94–106) использовать `compute_current_position_ms`:

```python
session_state = state_store.get_or_create(session_id)
now = server_now_ms()
welcome = WelcomeMessage(payload=WelcomePayload(
    session_id=session_id,
    your_user_id=user_id,
    video_url=session_state.video_url,
    is_playing=session_state.is_playing,
    position_ms=compute_current_position_ms(session_state, now),
    playback_rate=session_state.playback_rate,
    participants=manager.get_participants(session_id),
    server_time_ms=now,
))
```

Если новый клиент заходит в сессию во время воспроизведения — получит позицию на момент отправки Welcome. Возможный сдвиг ≈ RTT/2 (одностороння задержка Welcome) до того, как ClockSync синхронизируется. После первого успешного TimeSync клиент в синхроне. См. §9 — отложенное улучшение.

### 2.6 Удаление SessionState при пустой сессии

В `ConnectionManager.disconnect`, на ветке «если сессия пустая → del self._sessions[session_id]» (manager.py:67) — добавить вызов `state_store.drop(session_id)`. Это сохранит инвариант «состояние сессии живёт ровно столько, сколько живёт сама сессия».

### 2.7 Логирование

Все четыре команды — на уровне `INFO`. Формат:

```
[session=demo user=u1] Play: client_pos=45200 server_pos=45200 execute_at=1716890001200.3
```

`server_pos` = `new_state.position_ms` (или `compute_current_position_ms(old_state, execute_at)` для Pause — то же самое, что попадёт в broadcast). При расхождении `client_pos` и `server_pos` > 500 мс — `logger.warning` дополнительно (это сигнал «у клиента state поплыл»).

`events_log` (БД) пока не пишем — SQLAlchemy-моделей ещё нет, это отдельный шаг.

---

## 3. Фронтенд

### 3.1 Расширение типов протокола

В `frontend/src/types/protocol.ts`:

```ts
// --- ClientMessage добавления ---

export interface PlayRequestMessage {
  type: 'Play'
  payload: { position_ms: number }
}

export interface PauseRequestMessage {
  type: 'Pause'
  payload: { position_ms: number }
}

export interface SeekRequestMessage {
  type: 'Seek'
  payload: { position_ms: number }
}

export interface SetPlaybackRateRequestMessage {
  type: 'SetPlaybackRate'
  payload: { rate: number }
}

// --- ServerMessage добавления ---

export interface PlayBroadcastPayload {
  position_ms: number
  server_timestamp_ms: number
  execute_at_ms: number
}

export interface PlayBroadcastMessage {
  type: 'Play'
  payload: PlayBroadcastPayload
}

// Pause / Seek — те же поля, отдельные интерфейсы для DX (узкое сужение по type).

export interface SetPlaybackRateBroadcastPayload {
  rate: number
  position_ms: number
  server_timestamp_ms: number
  execute_at_ms: number
}

export interface SetPlaybackRateBroadcastMessage {
  type: 'SetPlaybackRate'
  payload: SetPlaybackRateBroadcastPayload
}

// WelcomePayload: + server_time_ms: number
```

Обновить `ClientMessage` и `ServerMessage` union-типы.

### 3.2 Структура модуля `frontend/src/playback/`

```
frontend/src/playback/
├── playbackMath.ts          # чистая математика: PlaybackState, compute/apply*
├── playbackMath.test.ts     # юнит-тесты только на чистые функции
├── PlaybackSync.ts          # оркестратор: WS-подписки, setTimeout, локальный state
└── usePlayback.ts           # React-хук — мост к компонентам
```

Принцип тот же, что в `sync/`: «грязь» (WS, таймеры, performance.now) — в `PlaybackSync.ts`, математика — в `playbackMath.ts`. Тесты только на математику.

### 3.3 Чистая математика `playbackMath.ts`

Зеркало серверной модели, но в **клиентской временной шкале**: anchor хранится не в серверных Unix ms, а в `performance.now()` ms (после пересчёта через `clockSync.getOffset()`).

```ts
export interface PlaybackState {
  isPlaying: boolean
  positionMs: number               // позиция в anchorPerfNowMs
  anchorPerfNowMs: number          // момент anchor в шкале performance.now()
  playbackRate: number
  videoUrl: string
}

export function computeCurrentPositionMs(state: PlaybackState, nowPerfNowMs: number): number {
  if (!state.isPlaying) return state.positionMs
  const elapsedMs = (nowPerfNowMs - state.anchorPerfNowMs) * state.playbackRate
  return state.positionMs + Math.floor(elapsedMs)
}

// applyPlay / applyPause / applySeek / applySetRate — те же что на бэке, но anchor в perfNow.

/**
 * Пересчёт execute_at (серверное Unix ms) в локальное performance.now()-время:
 * offset из ClockSync определён как (perfNow + offset = serverWallMs),
 * значит обратное: localPerfNow_for_server_X = X - offset.
 */
export function serverMsToLocalPerfNow(serverMs: number, clockOffsetMs: number): number {
  return serverMs - clockOffsetMs
}
```

### 3.4 Оркестратор `PlaybackSync.ts`

```ts
type SendFn = (msg: ClientMessage) => void
type GetOffsetFn = () => number
type GetOffsetReadyFn = () => boolean

export class PlaybackSync {
  private state: PlaybackState = { isPlaying: false, positionMs: 0,
                                   anchorPerfNowMs: 0, playbackRate: 1, videoUrl: '' }
  // Запланированные команды: один таймер на каждый тип. Новая того же типа
  // отменяет предыдущую (последний бродкаст — истина).
  private pendingTimers: Map<'Play'|'Pause'|'Seek'|'SetPlaybackRate', ReturnType<typeof setTimeout>> = new Map()
  private listeners: Set<() => void> = new Set()

  constructor(
    private send: SendFn,
    private getOffset: GetOffsetFn,
    private getOffsetReady: GetOffsetReadyFn,
  ) {}

  // --- Применение входящих бродкастов ---

  onPlayBroadcast(p: PlayBroadcastPayload): void {
    this.scheduleApply('Play', p.execute_at_ms, p.position_ms, /*rate*/ null,
      (localExecAtPerfNow) => this.applyPlay(p.position_ms, localExecAtPerfNow))
  }
  // onPauseBroadcast, onSeekBroadcast, onSetPlaybackRateBroadcast — аналогично.

  // --- Применение Welcome ---

  onWelcome(w: WelcomePayload): void {
    // Жёсткий ресет всех запланированных команд. Welcome приходит и при первом
    // подключении, и при переподключении после обрыва — в обоих случаях
    // запланированные ранее apply-таймеры неактуальны (state перезаписан).
    this.pendingTimers.forEach((t) => clearTimeout(t))
    this.pendingTimers.clear()

    // Anchor в шкале performance.now(). Если ClockSync уже готов и видео играет —
    // пересчитываем w.server_time_ms через offset, чтобы anchor соответствовал
    // моменту отправки Welcome сервером (а не моменту получения у клиента).
    // Это убирает погрешность ≈ RTT/2 в позиции при mid-session join.
    let anchorPerfNowMs: number
    if (w.is_playing && this.getOffsetReady()) {
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

  // --- Действия пользователя (кнопки в UI) ---

  requestPlay(): void {
    // Локальный state НЕ меняется. Шлём команду — ждём бродкаста.
    this.send({ type: 'Play', payload: { position_ms: this.currentPositionMs() } })
  }
  // requestPause / requestSeek(pos) / requestSetRate(r) — симметрично.

  // --- Хелперы ---

  /**
   * Планирование применения команды: рассчитываем localExecAt и delay,
   * — если delay > 0 → setTimeout,
   * — если delay ∈ (-50, 0] → apply немедленно,
   * — если delay < -50 → apply немедленно + adjust position (только для Play; см. §5.4).
   */
  private scheduleApply(
    cmdType: 'Play'|'Pause'|'Seek'|'SetPlaybackRate',
    executeAtServerMs: number,
    /* остальные параметры команды */
    ...
  ) { /* см. §3.5 ниже — детали логики */ }

  // --- Подписка на изменения для React ---

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getState(): Readonly<PlaybackState> { return this.state }

  currentPositionMs(): number {
    return computeCurrentPositionMs(this.state, performance.now())
  }
}
```

`PlaybackSync` не знает про `WSClient` и React — на вход получает callback `send` и `getOffset`. Это позволяет тестировать его с моками и переиспользовать.

### 3.5 Логика `scheduleApply` (детально)

```ts
private scheduleApply(
  cmdType: CommandType,
  executeAtServerMs: number,
  applyFn: (executeAtLocalPerfNow: number) => void,
): void {
  // Если уже есть запланированная команда того же типа — отменяем
  // (последний бродкаст истина; такая ситуация возможна при rapid clicks).
  const prev = this.pendingTimers.get(cmdType)
  if (prev !== undefined) clearTimeout(prev)

  const offset = this.getOffset()
  const localExecAtPerfNow = executeAtServerMs - offset
  const delayMs = localExecAtPerfNow - performance.now()

  const LATE_THRESHOLD_MS = -50

  if (delayMs > 0) {
    const t = setTimeout(() => {
      applyFn(localExecAtPerfNow)
      this.pendingTimers.delete(cmdType)
      this.emitChange()
    }, delayMs)
    this.pendingTimers.set(cmdType, t)
  } else if (delayMs > LATE_THRESHOLD_MS) {
    // Чуть опоздали (≤50мс) — применяем как есть, без корректировки.
    applyFn(localExecAtPerfNow)
    this.emitChange()
  } else {
    // Сильно опоздали (>50мс). Применяем «как будто это произошло в прошлом»
    // — это критично для Play: позиция уже «уехала» вперёд.
    // applyFn получает РЕАЛЬНОЕ время execute_at (в прошлом). Внутри Play
    // вычислится позиция = position_ms + (now - localExecAt) * rate, что и нужно.
    applyFn(localExecAtPerfNow)
    this.emitChange()
    console.warn(`[PlaybackSync] ${cmdType} late by ${(-delayMs).toFixed(1)}ms`)
  }
}
```

**Ключевое решение:** функция `applyFn` всегда получает **`localExecAtPerfNow`** (момент, когда команда должна была примениться по серверу), а не `performance.now()`. Внутри функций apply* anchor устанавливается именно в `localExecAtPerfNow`, что обеспечивает корректную позицию при late-применении: `computeCurrentPositionMs` потом сразу же выдаст «правильное сейчас». См. §5.4.

### 3.6 React-хук `usePlayback`

```ts
export interface PlaybackHookState {
  isPlaying: boolean
  positionMs: number          // live, обновляется при играющем состоянии
  playbackRate: number
  videoUrl: string
}

export function usePlayback(sync: PlaybackSync | null): {
  state: PlaybackHookState
  play: () => void
  pause: () => void
  seek: (positionMs: number) => void
  setRate: (rate: number) => void
} {
  const [tick, setTick] = useState(0)  // принудительная перерисовка

  useEffect(() => {
    if (!sync) return
    const unsub = sync.onChange(() => setTick(t => t + 1))

    // Live-обновление позиции во время воспроизведения: setInterval(100мс) —
    // достаточно для глаза, не нагружает CPU. requestAnimationFrame тоже
    // подойдёт, но избыточно для текстового индикатора.
    const interval = setInterval(() => {
      if (sync.getState().isPlaying) setTick(t => t + 1)
    }, 100)

    return () => { unsub(); clearInterval(interval) }
  }, [sync])

  if (!sync) {
    return { state: { isPlaying: false, positionMs: 0, playbackRate: 1, videoUrl: '' },
             play: noop, pause: noop, seek: noop, setRate: noop }
  }

  const s = sync.getState()
  return {
    state: {
      isPlaying: s.isPlaying,
      positionMs: sync.currentPositionMs(),  // live-вычисление
      playbackRate: s.playbackRate,
      videoUrl: s.videoUrl,
    },
    play:    () => sync.requestPlay(),
    pause:   () => sync.requestPause(),
    seek:    (ms) => sync.requestSeek(ms),
    setRate: (r) => sync.requestSetRate(r),
  }
}
```

### 3.7 Интеграция в `useWebSocket`

В `frontend/src/ws/useWebSocket.ts`: создать `PlaybackSync` рядом с `ClockSync` (он же одна жизнь на эффект):

```ts
const playback = new PlaybackSync(
  (msg) => client.send(msg),
  () => clock.getOffset(),
  () => clock.isReady(),
)
setPlaybackSync(playback)

client.on('message:Welcome',           (p) => { ... ; playback.onWelcome(p) })
client.on('message:Play',              (p) => playback.onPlayBroadcast(p))
client.on('message:Pause',             (p) => playback.onPauseBroadcast(p))
client.on('message:Seek',              (p) => playback.onSeekBroadcast(p))
client.on('message:SetPlaybackRate',   (p) => playback.onSetPlaybackRateBroadcast(p))
```

В возврат хука добавить `playbackSync: PlaybackSync | null`. RoomScreen его и получает.

### 3.8 UI: контролы в `App.tsx::RoomScreen`

Добавить блок «Воспроизведение», размещённый между Sync-индикатором и списком участников.

```
┌─ Воспроизведение ────────────────────────────────────────┐
│  ▶ Play  /  ⏸ Pause   (одна кнопка с переключением)      │
│  Позиция: 00:01:23.456    [▶ |seek_to_ms input|]  Seek   │
│  Скорость: [0.25 0.5 0.75 1.0 1.25 1.5 1.75 2.0]         │
│  Видео: <video_url или «не задано»>                       │
└──────────────────────────────────────────────────────────┘
```

Детали:
- Кнопка Play/Pause: подпись зависит от `isPlaying`. При нажатии вызывает `play()` или `pause()` соответственно. Локальный state не меняется — это важно: пользователь видит ≈200 мс «инерции» между кликом и реакцией. Это норма, см. §5.5.
- Поле Seek: input для ввода миллисекунд + кнопка «Перейти». Можно дополнить форматом mm:ss как полировку, но не блокер.
- Селект скорости: 8 фиксированных значений из протокола. Текущее значение — выделено.
- Позиция: формат `HH:MM:SS.mmm`, обновляется каждые 100 мс при игре, статична на паузе. Это и главная визуальная проверка синхронизации между двумя клиентами в одной комнате.

---

## 4. Тесты

### 4.1 Backend (pytest)

Установить pytest и pytest-asyncio (последний — для будущих интеграционных тестов WS, не обязателен на этом этапе). В `requirements.txt` + `pytest.ini` (или секция в `pyproject.toml`).

`backend/tests/test_session_state.py`:

1. **`compute_current_position_ms` — статика.** is_playing=False → возвращает position_ms независимо от now_ms.
2. **`compute_current_position_ms` — динамика.** is_playing=True, rate=1.0, position_ms=1000, anchor=10000. Для now_ms=12000 → ожидаем 3000.
3. **`compute_current_position_ms` — с rate ≠ 1.** rate=2.0, та же ситуация → 5000. rate=0.5 → 2000.
4. **`apply_play` — идемпотентность.** Из состояния is_playing=True вернёт тот же объект (`is`).
5. **`apply_play` — переход из паузы.** position_ms сохраняется, anchor=execute_at, is_playing=True.
6. **`apply_pause` — идемпотентность.**
7. **`apply_pause` — фиксация позиции на execute_at.** Из (playing, pos=1000, anchor=10000, rate=1.0) при execute_at=12000 → (paused, pos=3000, anchor=12000).
8. **`apply_pause` с rate ≠ 1.** Та же ситуация, rate=2.0 → pos=5000.
9. **`apply_seek` — сохраняет is_playing.** Тестировать оба варианта (играл/пауза).
10. **`apply_set_rate` — сохраняет непрерывность.** position_at_exec вычисляется по СТАРОМУ rate, новый anchor=execute_at, новый rate действует после.
11. **Композиция Play → SetRate(2.0) → Pause → Seek.** Проверить итоговое состояние после серии.

### 4.2 Frontend (vitest)

`frontend/src/playback/playbackMath.test.ts` — зеркало серверных тестов:

1. **`computeCurrentPositionMs`** — все ветки и комбинации rate.
2. **`applyPlay/Pause/Seek/SetRate`** — те же кейсы.
3. **`serverMsToLocalPerfNow`** — простейший арифметический тест: при offset=1.7e12, server=1716890001200 → local≈200.

Отдельный сценарий (не в playbackMath, а отдельный тест для PlaybackSync, если успеваем):

4. **Late-command для Play.** Симулировать сценарий: пришёл бродкаст Play с `execute_at_ms` соответствующий моменту -300 мс назад в локальной шкале. После apply: `computeCurrentPositionMs(state, performance.now())` должна вернуть `position_ms + 300 мс * rate` (с допуском на округление). Тест проверяет, что late-применение НЕ теряет проигранные миллисекунды.

`PlaybackSync.test.ts` — опционально. Тестирование с fake timers (`vi.useFakeTimers()`) и моками `send`/`getOffset`. Если будет туго по времени — оставить как отдельный коммит позже; ядро покрыто математикой.

### 4.3 Ручная проверка (после реализации)

Сценарии демонстрации на двух браузерных вкладках:

1. **Базовая синхронизация.** Один клик Play на клиенте A → у обоих позиция начинает двигаться через ~200 мс с момента клика. Визуально позиции идут синхронно (рассинхрон ≤ 100 мс невооружённым глазом не видно — для оценки вывести `console.log` каждые 100 мс на обоих).
2. **Seek.** На клиенте A ввести `120000` и нажать Seek → у обоих позиция перепрыгивает.
3. **SetPlaybackRate во время игры.** На клиенте A выбрать 1.5x → у обоих скорость движения позиции меняется одновременно.
4. **Late-команда.** Открыть DevTools → Network → Throttling → Slow 3G на клиенте B. На клиенте A нажать Play. У B команда пришла с опозданием → должна примениться немедленно с corrected position. В консоли B — `[PlaybackSync] Play late by Nms`.
5. **Mid-session join.** Клиент A запускает Play. Через 10 секунд подключается клиент B → видит позицию ≈ 10000 мс, состояние playing, продолжает синхронно.

Замер реального рассинхрона: вывести у обоих клиентов `clockSync.getServerTime() + " | pos=" + currentPositionMs()` каждые 100 мс. Сравнить позиции при одном и том же `getServerTime()` (округлять до 100 мс).

---

## 5. Обоснования (для главы 2 диплома)

### 5.1 `EXECUTE_AT_DELAY_MS = 200`

Бюджет задержки складывается из:
- Одностороння задержка `server → client` для медианного клиента в публичной сети: 20–50 мс.
- Jitter (95-й перцентиль над медианой): +30–50 мс.
- Время на десериализацию JSON + обработку в React + `setTimeout`-постановку: 5–20 мс.
- Резерв на длинный хвост («один клиент с RTT 200 мс»): 50–100 мс.

Итого 105–220 мс. **200 мс** — округление вверх до круглого числа, дающее запас для 95-го перцентиля и при этом не превращающее интерфейс в ощутимо «лагающий» (300+ мс уже заметно бросаются в глаза).

Альтернативы рассматривались:
- **100 мс:** слишком тесно. Клиенты с RTT > 100 мс будут постоянно срабатывать в late-ветке, что нивелирует смысл compensation.
- **500 мс:** даёт большой запас (хорошо для нестабильных мобильных сетей), но интерфейс ощущается «деревянным». Для синхронного просмотра видео между друзьями — слишком много.

Параметр **выносится в константу** и при реальном нагрузочном тесте 30 клиентов будет уточнён эмпирически. В защиту диплома это и формулируется как «адаптивно настраиваемая величина».

### 5.2 Серверно-авторитетная модель с anchor-формулой

Альтернативы:
- **(A) Сервер сэмплирует current_position и шлёт каждый момент времени** — бессмысленно: чтобы клиенты применили эти сэмплы согласованно, всё равно нужен `execute_at`.
- **(B) Сервер шлёт `{state, server_time}` периодически (раз в N секунд)** — между обновлениями клиенты «летят на ощупь», ничего не выигрываем по сравнению с нашей моделью, но платим трафиком.
- **(C) Anchor-формула (наша):** позиция полностью определяется тройкой `(position_ms, anchor_server_ms, is_playing) + playback_rate`. Между командами рассылок ноль. Каждый клиент сам вычисляет «где сейчас» по той же формуле, что и сервер, с поправкой на свой `clockOffset`.

Преимущества (C):
- Минимум трафика: одна команда — одна рассылка на всех.
- Детерминизм: формула одна и та же на сервере и клиенте, любое расхождение детектируется в логах.
- Точность ограничена только точностью `ClockSync` (∼1 мс на localhost, до ∼50 мс в публичной сети).

### 5.3 Идемпотентность Play / Pause vs всегда-бродкаст Seek / SetRate

Play и Pause — **переключатели состояния**. Если состояние уже совпадает с запрошенным, действие пользователя физически бессмысленно (он не мог увидеть текущее состояние и при этом нажать «начать то, что и так начато»). Рассылка такой команды нагружает сеть и дёргает плееры (которые внутри iframe API могут реагировать на дублирующий `play()` — например, RuTube перезапускает сэмплирование). Никакой потери информации — клиенты, не имевшие актуального состояния, всё равно получат его в следующем бродкасте или Welcome.

Seek и SetPlaybackRate — **прямые жесты**. Пользователь явно сказал «перемотай на 120000» или «поставь 1.5x», даже если значение совпадает с текущим. Скрывать такие действия неправильно по двум причинам:
1. **Намеренная пересинхронизация.** Если у одного клиента видно, что позиция уплыла, он может нажать «Seek на текущую» с целью «жёстко вернуть всех на одну метку». Идемпотентный no-op это сломает.
2. **Аудит.** В будущем `events_log` должен содержать все действия пользователей, включая «пользователь подтвердил скорость».

### 5.4 Корректировка позиции при late-команде

Если бродкаст Play пришёл с задержкой 300 мс (например, у клиента кратковременный сетевой провал) — `delayMs = local_execute_at - performance.now() = -300`. Что мы делаем:

- **Play:** anchor устанавливается в `local_execute_at` (момент в прошлом). Следующий вызов `computeCurrentPositionMs(state, performance.now())` сразу вернёт `position_ms + 300 * rate` — позиция, на которой должен быть клиент СЕЙЧАС, если бы он применил команду вовремя. **Корректность сохраняется автоматически**, без явной логики «adjust position», за счёт того что мы выбрали хранить anchor в шкале времени (а не как «текущую позицию»).
- **Pause:** anchor=local_execute_at, position=position_ms (как пришло). При следующем `computeCurrentPositionMs` — is_playing=False → возвращает position_ms неизменным. Корректно.
- **Seek:** anchor=local_execute_at, position=new_position_ms. Если был playing, продолжит играть от new_position_ms с момента local_execute_at в прошлом → текущая позиция = new_position_ms + 300 * rate. Корректно.
- **SetPlaybackRate:** position в payload уже посчитана сервером как `compute_current_position_ms(state, execute_at_ms)` — то есть, **то же самое**, что мы посчитали бы локально, если бы успели вовремя. anchor=local_execute_at, position=position_ms (из payload), rate=new_rate. Корректно.

Это и есть главная причина, почему **anchor хранится в шкале времени, а не как «текущая позиция»**: один и тот же код корректно работает и для своевременных, и для опоздавших команд.

Порог `-50 мс` — это просто граница, после которой логируем `console.warn` для диагностики. До -50 — норма (jitter), хуже -50 — стоит обратить внимание.

### 5.5 Локальный state не меняется до бродкаста

Это центральное архитектурное решение, отличающее наш подход от «оптимистичного UI» (где локальное действие применяется сразу, а сервер потом подтверждает).

**Плюсы оптимистичного UI:** мгновенная реакция, ощущение отзывчивости.

**Минусы (почему мы их не выбираем):**
1. **Рассинхрон.** Пользователь A с RTT 50 мс «уже играет», пользователь B с RTT 300 мс «ещё нет». Между ними 250 мс рассинхрона. С `execute_at` — 0 (плюс jitter `~clockSync.uncertainty`).
2. **Откат при ошибке.** Если сервер отверг команду (например, INVALID_RATE) — приходится откатывать локальное состояние, что зрелищно ломает UX.
3. **Конфликт команд.** Два пользователя одновременно нажали Play и Pause. При оптимистичном — у каждого своё состояние, потом скачок. При нашем — сервер их сериализует, оба видят одинаковую финальную картину через 200 мс.

Цена нашего подхода: пользователь видит **≈200 мс задержки** между кликом и визуальной реакцией. Это в пределах естественного восприятия (порог обнаружения задержки нажатия — около 100 мс; 200 мс ощущается как «солидная», но не «лагающая»). Для синхронного просмотра видео — приемлемо.

### 5.6 Зачем добавили `position_ms` в SetPlaybackRate broadcast

Изменение скорости — операция, при которой **позиция должна быть непрерывной** (видео не должно перепрыгнуть на 5 секунд назад/вперёд при переходе с 1.0x на 2.0x). Это требует, чтобы новый anchor приходил вместе с позицией на момент anchor.

Без `position_ms` в payload клиент должен сам посчитать «где я был на момент execute_at» по старому rate. Это требует:
- Точного хранения локального `(positionMs, anchorPerfNowMs, oldRate)`.
- Гарантии что между прошлой командой и SetPlaybackRate не произошло событий, которые могли бы сдвинуть anchor.

Сервер уже всё это считает (имеет authoritative state). Передать в payload — одно поле, ноль дополнительной сложности на бэке, сильно проще логика на клиенте, проще тестировать.

Это **расширение протокола** — нужно одновременно обновить `docs/protocol.md`.

### 5.7 Точность вычисления позиции

Округление позиции выполняется одинаково на обеих сторонах: `int()` на бэке (Python усекает к нулю для положительных чисел, что эквивалентно floor) и `Math.floor` на фронте. Использование floor даёт стабильную нижнюю границу позиции, без скачков в обе стороны от истинного значения (как было бы при `round`).

Накопительный дрейф между двумя последовательными rebroadcast при `rate = 1.0` ≤ 1 мс на команду — каждая операция отбрасывает максимум 1 мс дробной части. Это **на порядок ниже целевой точности 50 мс** из ТЗ. При повышенных rate (2.0x) дрейф пропорционально растёт, но остаётся в пределах единиц миллисекунд за разумную серию команд.

Альтернатива — хранить позицию в `float` мс (`position_ms: float`) — отвергнута: создаёт визуальный шум в логах/UI (числа вида `45200.4567`), плюс целочисленная позиция упрощает сравнения и сериализацию. Выигрыш в точности (< 1 мс) пренебрежим относительно общего бюджета синхронизации.

---

## 6. Порядок реализации (по коммитам)

Каждый шаг — отдельный коммит. Тесты пишутся вместе с соответствующим кодом, не откладываются на конец.

1. **Backend: SessionState — чистые функции + pytest.**
   - `app/services/__init__.py`, `app/services/session_state.py`.
   - Установка pytest, конфиг (`pytest.ini` или секция в `pyproject.toml`).
   - `backend/tests/test_session_state.py` со всеми тестами из §4.1.
   - `pytest` — все зелёные.

2. **Backend: схемы команд + `EXECUTE_AT_DELAY_MS`.**
   - Расширение `app/schemas/messages.py` (Play/Pause/Seek/SetPlaybackRate Request + Broadcast, расширение WelcomePayload).
   - `EXECUTE_AT_DELAY_MS` в `app/sync/clock.py`.

3. **Backend: обработчик в `handler.py` + обновление Welcome.**
   - Четыре ветки на команды.
   - Welcome с актуальной позицией и `server_time_ms`.
   - Очистка state при пустой сессии (в `ConnectionManager.disconnect` либо хук из handler).
   - Ручная проверка: один клиент шлёт Play (через DevTools → WS), сервер отвечает бродкастом.

4. **`docs/protocol.md`: актуализация.**
   - Переименование `server_timestamp` → `server_timestamp_ms`, `execute_at` → `execute_at_ms` (единый стиль с TimeSync).
   - Добавление `position_ms` в SetPlaybackRate (исходящий).
   - Добавление `server_time_ms` в Welcome.

5. **Frontend: типы протокола.**
   - Расширение `types/protocol.ts` со всеми новыми типами.
   - Обновление union-типов `ClientMessage` и `ServerMessage`.

6. **Frontend: `playbackMath.ts` + vitest.**
   - Все чистые функции.
   - `playbackMath.test.ts` со сценариями §4.2.
   - `npm test` — зелёные.

7. **Frontend: `PlaybackSync` + хук `usePlayback`.**
   - Полная логика scheduleApply, обработка late-команд.
   - Интеграция в `useWebSocket.ts` рядом с `ClockSync`.

8. **Frontend: UI-контролы в `RoomScreen`.**
   - Кнопки Play/Pause, поле Seek, селект Rate.
   - Дисплей позиции live-обновляемый.

9. **Финальная ручная проверка по сценариям §4.3.**
   - Все 5 сценариев. Замер реального рассинхрона между двумя клиентами через `console.log`.
   - Обновить `NOTES.md` — раздел «Сессия 4 — команды Play/Pause/Seek».

После шага 9 можно начинать **адаптеры плееров** (RuTube + VK Video — приоритет). Виртуальный плеер заменяется на `IPlayerAdapter`, к которому `PlaybackSync` уже готов: applyFn будет вызывать `adapter.play() / .seek(ms)` вместо обновления локального state.

---

## 7. Критерии готовности

- [ ] Два клиента в одной комнате. Клик Play на одном → у обоих позиция стартует с задержкой ≈ 200 мс относительно момента клика, рассинхрон между ними при глазомерной проверке отсутствует.
- [ ] Pause / Seek / SetPlaybackRate работают на обоих синхронно.
- [ ] Late-команда (Slow 3G на одном клиенте) применяется немедленно с корректной позицией. В консоли — `[PlaybackSync] X late by Nms`.
- [ ] Mid-session join: новый клиент получает текущую позицию в Welcome и продолжает синхронно.
- [ ] `pytest` — все тесты `test_session_state.py` зелёные.
- [ ] `npm test` — все тесты `playbackMath.test.ts` зелёные.
- [ ] При искусственном замере (console.log позиций каждые 100 мс) рассинхрон между двумя клиентами в стационарном режиме на localhost — ≤ 50 мс, на симуляции Slow 3G — ≤ 200 мс.
- [ ] Сервер пишет в `INFO`-лог каждую команду в формате `Play: client_pos=X server_pos=Y execute_at=Z`.
- [ ] При отключении последнего участника в сессии — `state_store.drop(session_id)` отрабатывает (проверить логом).

---

## 8. Согласованные решения

1. **Источник истины — серверный `SessionState` с anchor-формулой.** Клиенты не имеют права изменять локальный state в обход бродкаста.
2. **`execute_at = server_now_ms() + 200 мс`.** Параметр настраиваемый (`EXECUTE_AT_DELAY_MS`).
3. **Идемпотентные no-op для Play / Pause** при совпадении состояния. Always-broadcast для Seek / SetPlaybackRate — это явные жесты пользователя.
4. **Локальный state не меняется при действии пользователя** — только при получении бродкаста. Цена — ≈ 200 мс «инерции» UI; выигрыш — точная синхронизация между клиентами.
5. **SetPlaybackRate broadcast расширяется на `position_ms`** для непрерывности позиции при смене скорости. Это намеренное расширение `docs/protocol.md`.
6. **Welcome содержит `server_time_ms`** — используется в `PlaybackSync.onWelcome` для корректировки anchor при `is_playing=true`, если `clockSync.isReady() === true`. Fallback на `performance.now()` если не готов (первое подключение — ClockSync стартует после Welcome).
7. **Late-команда (delay < -50 мс):** apply немедленно. Корректность позиции обеспечивается тем, что anchor хранится в шкале времени — формула `computeCurrentPositionMs` автоматически выдаёт правильное значение.
8. **`position_ms` в Play/Pause-запросе клиента** — диагностика, в логике сервера не используется.
9. **Один таймер на тип команды** в `PlaybackSync.pendingTimers`. Новая Play отменяет предыдущую Play, но не отменяет запланированный Seek (разные типы, могут сосуществовать).
10. **Удаление SessionState при пустой сессии** — комната с нулём участников = удалённая.
11. **Имена полей в новых бродкастах: `server_timestamp_ms`, `execute_at_ms`** — суффикс `_ms` для единообразия с TimeSync (`client_send_ms`, `server_receive_ms`). Старый черновик `docs/protocol.md` использовал `server_timestamp` / `execute_at` — этот документ обновляется на шаге 4.

---

## 9. Отложенные улучшения (TODO)

1. **Коррекция Welcome через ClockSync.** Сейчас новый клиент применяет `position_ms` сразу, с погрешностью ≈ RTT/2 до первой синхронизации часов. После первого успешного TimeSync можно один раз пересчитать позицию с учётом `(server_time_ms_welcome, текущее_server_time, isPlaying, rate)`. Откладываем — погрешность < 50 мс приемлема для диплома.

2. **Запись событий в `events_log`.** Требует SQLAlchemy-моделей, которые ещё не реализованы. Отдельная итерация.

3. **Права доступа.** Сейчас любой участник может управлять. Возможный режим: только owner/moderator. Решение — после реализации функционала ролей в UI.

4. **Длительность видео.** Без duration в SessionState невозможна валидация `position_ms ≤ duration`. После интеграции адаптеров плееров — добавить, в этом плане поле не вводим.

5. **Throttling rapid-fire команд.** Если пользователь дёргает Seek много раз в секунду, сервер пропускает все. На сильной нагрузке (30 клиентов) может понадобиться debounce на стороне клиента или rate limit на сервере. На этом этапе — не блокер.

6. **Тесты PlaybackSync с fake timers.** В §4.2 включены опционально. Если ядро (математика) покрыто и ручная проверка прошла — можно отложить.

7. **UX при NICKNAME_TAKEN** (наследие сессии 2) — не делать 8 попыток реконнекта, сразу показывать «выберите другой ник».
