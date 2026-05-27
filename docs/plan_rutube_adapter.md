# План: адаптер RuTube + интеграция с PlaybackSync

## Текущее состояние (что уже есть)

- `frontend/src/players/IPlayerAdapter.ts` — интерфейс + `BasePlayerAdapter`. Метод `seek(seconds)` принимает **секунды**.
- `frontend/src/players/PlayerFactory.ts` — скелет: `detectPlatform()` есть, создание адаптера бросает `Error("ещё не реализован")`.
- `PlaybackSync` ведёт виртуальный state (`this.state: PlaybackState`) — без реального плеера.
- `SessionState.video_url` уже есть в серверной модели, но `SetVideoUrl`-команды протокол не знает.

---

## A. Интерфейс `IPlayerAdapter`

### Что уже сделано

Файл `frontend/src/players/IPlayerAdapter.ts` содержит финальную версию:

```ts
interface IPlayerAdapter {
  play(): Promise<void>
  pause(): Promise<void>
  seek(seconds: number): Promise<void>        // ← секунды, не мс!
  setPlaybackRate(rate: number): Promise<void>
  getCurrentTime(): Promise<number>           // ← возвращает секунды
  getDuration(): Promise<number>              // ← возвращает секунды
  isReady(): boolean
  on(event: PlayerEvent, cb: (...args: unknown[]) => void): void
  off(event: PlayerEvent, cb: (...args: unknown[]) => void): void
  destroy(): void
}
```

### Единица времени в адаптере — секунды

**Ключевое решение:** адаптер работает в секундах, PlaybackSync — в миллисекундах. Граница перевода — на стороне PlaybackSync при вызовах адаптера:

```ts
// PlaybackSync → адаптер
adapter.seek(positionMs / 1000)
// getCurrentTime адаптера → PlaybackSync
const positionMs = (await adapter.getCurrentTime()) * 1000
```

**Почему в секундах:** все внешние API (YouTube, Vimeo) используют секунды. RuTube — исключение (мс), но это нормализуется внутри `RutubeAdapter`, а не выносится в интерфейс. Интерфейс выражает «что это такое», а не «как хранит конкретный хостинг».

### Добавить тип события `error`

Расширить `PlayerEvent`:

```ts
export type PlayerEvent = 'play' | 'pause' | 'seek' | 'timeupdate' | 'ready' | 'error'
```

`error` нужен для геоблокировок и несуществующих видео. На этом этапе только логируется, не блокирует. Без этого расширения добавить его позже будет ломающим изменением.

### Никаких других изменений интерфейса

`IPlayerAdapter` достаточен для всех четырёх платформ. Специфика каждой инкапсулируется внутри конкретного адаптера.

---

## B. `RutubeAdapter`

### Файл: `frontend/src/players/RutubeAdapter.ts`

### B.1 postMessage API RuTube

Embed URL: `https://rutube.ru/play/embed/<video_id>`

Исходящие сообщения (клиент → iframe):

| Команда | Формат postMessage |
|---|---|
| Воспроизвести | `{ type: 'player:play' }` |
| Пауза | `{ type: 'player:pause' }` |
| Перемотка | `{ type: 'player:setCurrentTime', data: { time: <секунды> } }` |
| Запрос позиции | `{ type: 'player:getCurrentTime' }` |
| Запрос длины | `{ type: 'player:getDuration' }` |

> **Примечание по единице в setCurrentTime:** CLAUDE.md указывает «миллисекунды», однако большинство публичных реализаций и поведение HTML5 MediaElement-основанных плееров предполагают секунды. Нужно верифицировать эмпирически при запуске. В плане пишем секунды — если нужно будет исправить, меняем только одно место в адаптере (`time: seconds` → `time: seconds * 1000`).

Входящие события (iframe → клиент через `window.addEventListener('message', ...)`):

| Событие | Формат | Описание |
|---|---|---|
| Готовность | `{ type: 'player:ready' }` | Плеер загружен, готов к командам |
| Смена состояния | `{ type: 'player:changeState', data: { state: 'playing'\|'paused'\|'stopped'\|'ended' } }` | Пользователь/программа изменил состояние |
| Текущее время | `{ type: 'player:currentTime', data: { time: <секунды> } }` | ~каждую секунду при воспроизведении |
| Длина | `{ type: 'player:durationChange', data: { duration: <секунды> } }` | После загрузки метаданных |
| Ошибка | `{ type: 'player:error', data: { ... } }` | Ошибка плеера |

Все postMessage отправляются с `targetOrigin: 'https://rutube.ru'` (не `'*'`) — это мера безопасности.

### B.2 Извлечение video_id из URL

Пользователь вводит любой URL RuTube:
- `https://rutube.ru/video/abc123def456/` → video_id = `abc123def456`
- `https://rutube.ru/video/abc123def456` → video_id = `abc123def456`
- `https://rutube.ru/play/embed/abc123def456` → уже embed, video_id = `abc123def456`

Регулярное выражение: `/rutube\.ru\/(?:video|play\/embed)\/([a-zA-Z0-9]+)/i`

> **Почему `[a-zA-Z0-9]+` а не `[a-f0-9]+`:** видео-ID RuTube содержит буквы не только из hex-алфавита. Использование только `[a-f0-9]` отсекло бы реальные ссылки.

Embed URL формируется как: `https://rutube.ru/play/embed/${videoId}?skinColor=ff6600`

### B.3 Структура класса

```ts
// Флаг единицы времени: true = setCurrentTime принимает мс, false = секунды.
// Определяется эмпирически по первому player:currentTime событию.
// Значение по умолчанию: false (секунды). При верификации переключить если нужно.
const TIME_UNIT_MS = false

export class RutubeAdapter extends BasePlayerAdapter {
  private iframe: HTMLIFrameElement
  private ready = false
  private currentTimeSec = 0
  private durationSec = 0

  // Флаг: первое player:currentTime ещё не получено (для логирования единицы)
  private firstCurrentTimeReceived = false

  // Буфер команд до ready. Храним последнюю команду каждого типа
  private pendingPlay = false
  private pendingSeekSec: number | null = null

  private readonly messageHandler: (e: MessageEvent) => void
```

### B.4 Жизненный цикл

**Конструктор:**
1. Создаёт `<iframe>` с нужным `src`, `allow="autoplay"`, без `sandbox` (postMessage работает по одному policy origin).
2. Добавляет `src` в `<iframe>` — загрузка стартует.
3. Регистрирует `window.addEventListener('message', this.messageHandler)`.
4. Добавляет iframe в `container`.

**destroy():**
1. `window.removeEventListener('message', this.messageHandler)`.
2. Убирает iframe из DOM: `iframe.remove()`.
3. Очищает pendingPlay, pendingSeekSec.

**Почему убираем listener через `window` а не через `iframe`:** postMessage в кросс-origin сценарии приходит на `window`, не на сам iframe. Один listener на весь window — стандартный паттерн; адаптер фильтрует по двойному условию:

```ts
if (e.source !== this.iframe.contentWindow) return
if (e.origin !== 'https://rutube.ru') return
```

Двойная фильтрация: `e.source` исключает сообщения от других iframe (если их несколько), `e.origin` исключает сообщения от других хостингов и защищает от postMessage-инъекций со сторонних сайтов.

### B.5 Буферизация команд до `ready`

```ts
async play(): Promise<void> {
  if (!this.ready) {
    this.pendingPlay = true
    this.pendingSeekSec = null  // play сбрасывает pending-seek? нет — seek + play совместимы
    return
  }
  this.withSuppression(() => this.send({ type: 'player:play' }))
}
```

При `player:ready`:
1. `this.ready = true`
2. Если `pendingSeekSec !== null` → выполнить seek
3. Если `pendingPlay === true` → выполнить play
4. `emit('ready')`

**Порядок важен:** сначала seek, потом play. Иначе видео начнёт играть с начала, а потом перепрыгнет.

### B.6 `setPlaybackRate` — не поддерживается

```ts
async setPlaybackRate(rate: number): Promise<void> {
  if (rate !== 1.0) {
    console.warn(
      `[RutubeAdapter] setPlaybackRate(${rate}) не поддерживается RuTube embed API. ` +
      'Команда проигнорирована.'
    )
  }
  // resolve без действия
}
```

Решение принято на основе: RuTube не документирует `player:setPlaybackRate` в embed API. Если в будущих версиях поддержка появится — добавить одну строку. Пока — явный warn в консоли, который также показывается в UI (раздел H).

### B.7 `getCurrentTime` — через Promise с коротким timeout

RuTube не возвращает время синхронно. Адаптер кэширует последнее значение из события `player:currentTime` в `this.currentTimeSec`.

```ts
async getCurrentTime(): Promise<number> {
  return this.currentTimeSec  // кэшированное из события, всегда доступно
}
```

Это не мгновенный запрос-ответ, а просто последнее известное время — достаточно для PlaybackSync, которому нужна оценка позиции, а не точная синхронная позиция. Точность ограничена частотой обновления `player:currentTime` (~1 сек).

---

## C. Интеграция с PlaybackSync

### C.1 Как передать адаптер в PlaybackSync

`PlaybackSync` не знает в момент создания, какой адаптер будет. URL задаётся позже пользователем. Поэтому — метод `setAdapter`:

```ts
// PlaybackSync.ts

private adapter: IPlayerAdapter | null = null

setAdapter(adapter: IPlayerAdapter | null): void {
  this.adapter = adapter
}
```

`setAdapter(null)` вызывается при смене URL — старый адаптер уничтожается снаружи (в React-компоненте), новый создаётся, потом `setAdapter(newAdapter)`.

### C.2 Вызовы адаптера в apply-функциях

В `scheduleApply` — `applyFn` обновляет `this.state` и вызывает адаптер:

```ts
onPlayBroadcast(p: PlayBroadcastPayload): void {
  this.scheduleApply('Play', p.execute_at_ms, (localExecAt) => {
    this.state = applyPlay(this.state, localExecAt)
    this.adapter?.play()   // ← новое
  })
}

onPauseBroadcast(p: PauseBroadcastPayload): void {
  this.scheduleApply('Pause', p.execute_at_ms, (localExecAt) => {
    this.state = applyPause(this.state, localExecAt)
    this.adapter?.pause()  // ← новое
  })
}

onSeekBroadcast(p: SeekBroadcastPayload): void {
  this.scheduleApply('Seek', p.execute_at_ms, (localExecAt) => {
    this.state = applySeek(this.state, localExecAt, p.position_ms)
    this.adapter?.seek(p.position_ms / 1000)  // ← мс → секунды
  })
}

onSetPlaybackRateBroadcast(p: SetPlaybackRateBroadcastPayload): void {
  this.scheduleApply('SetPlaybackRate', p.execute_at_ms, (localExecAt) => {
    this.state = { ... }
    this.adapter?.setPlaybackRate(p.rate)  // ← RuTube выдаст console.warn если rate ≠ 1
  })
}
```

### C.3 Синхронизация адаптера при его подключении

Когда пользователь задал URL и адаптер только что создан — нужно привести его в состояние, совпадающее с текущим `this.state`.

**Важно: race condition.** Если адаптер уже `isReady() === true` в момент вызова `setAdapter` (теоретически — если создан заранее и уже загружен), событие `ready` никогда не придёт. Правильный порядок — подписаться ДО проверки `isReady()`:

```ts
setAdapter(adapter: IPlayerAdapter | null): void {
  this.adapter = adapter
  if (!adapter) return

  const onReady = () => {
    adapter.off('ready', onReady)  // снять подписку — чтобы не сработать дважды
    const s = this.state
    if (s.positionMs > 0) {
      adapter.seek(s.positionMs / 1000)
    }
    if (s.isPlaying) {
      adapter.play()
    }
  }

  // Сначала подписываемся, потом проверяем — исключает гонку
  adapter.on('ready', onReady)
  if (adapter.isReady()) {
    onReady()  // если уже ready, ready-событие не придёт
  }
}
```

### C.4 Реакция на iframe-действия пользователя — откладывается (TODO)

Если пользователь нажал паузу внутри iframe RuTube (мимо нашего UI) — адаптер эмитит `pause`. PlaybackSync мог бы слушать это событие и вызывать `requestPause()`.

**Риск:** `suppressionCount > 0` блокирует события от наших команд, но граница между «наш» и «пользовательский» — временная. Если пользователь нажал паузу ровно в период suppressionCount > 0 — его действие пропадёт. Это редкий случай (200 мс окно), но не ноль.

**Решение для диплома (отложено):** более надёжная архитектура — две очереди (pending commands vs. user actions), но это усложнение. Для текущего этапа: PlaybackSync **не** подписывается на события адаптера. Iframe-действия пользователя будут рассинхронизировать его с остальными — это компромисс, явно зафиксированный как TODO.

**Почему это приемлемо:** в типичном сценарии синхронного просмотра один человек управляет через UI приложения, остальные только смотрят. Прямой контроль через iframe — edge case, не основной flow.

---

## D. UI-интеграция

### D.1 Новый тип сообщения `SetVideoUrl`

Нужна отдельная команда в протоколе — URL является серверно-авторитетным состоянием (см. F.3).

**Клиент → Сервер:**

```json
{
  "type": "SetVideoUrl",
  "payload": { "video_url": "https://rutube.ru/video/abc123/" }
}
```

**Сервер → все клиенты:**

```json
{
  "type": "VideoUrlChanged",
  "payload": { "video_url": "https://rutube.ru/video/abc123/" }
}
```

**Валидация на сервере:**
- Длина URL ≤ 2048 символов.
- `PlayerFactory.detect(url)` — известная платформа (`rutube`, `vkvideo`, `youtube`, `vimeo`) или пустая строка (сброс видео). Всё остальное → `Error("UNSUPPORTED_PLATFORM")`.

**Идемпотентность:** если `video_url` совпадает с текущим — сервер не рассылает (no-op), логирует INFO. Отправитель не получает никакого подтверждения no-op — fire-and-forget, как Play/Pause при уже совпадающем состоянии.

### D.2 Backend

В `app/schemas/messages.py`:

```python
class SetVideoUrlPayload(BaseModel):
    video_url: str = Field(max_length=2048)

class SetVideoUrlMessage(BaseModel):
    type: Literal["SetVideoUrl"]
    payload: SetVideoUrlPayload

class VideoUrlChangedPayload(BaseModel):
    video_url: str

class VideoUrlChangedMessage(BaseModel):
    type: Literal["VideoUrlChanged"] = "VideoUrlChanged"
    payload: VideoUrlChangedPayload
```

В `handler.py` — ветка для `SetVideoUrl`:

```python
if msg_type == "SetVideoUrl":
    req = SetVideoUrlMessage.model_validate(parsed)
    old_state = state_store.get_or_create(session_id)
    if req.payload.video_url == old_state.video_url:
        continue  # no-op
    new_state = SessionState(
        ...old_state,
        video_url=req.payload.video_url,
        # При смене видео — сбросить позицию и паузу
        is_playing=False,
        position_ms=0,
        anchor_server_ms=server_now_ms(),
    )
    state_store.set(session_id, new_state)
    broadcast_msg = VideoUrlChangedMessage(
        payload=VideoUrlChangedPayload(video_url=req.payload.video_url)
    )
    await manager.broadcast(session_id, broadcast_msg.model_dump_json())
```

**При смене URL — сброс позиции и паузы.** Логика: новое видео начинается с нуля. Альтернатива «сохранить позицию» отклонена — у нового видео другая длина, позиция может быть невалидной.

### D.3 Frontend — типы протокола

В `frontend/src/types/protocol.ts` добавить:

```ts
export interface SetVideoUrlMessage {
  type: 'SetVideoUrl'
  payload: { video_url: string }
}

export interface VideoUrlChangedPayload {
  video_url: string
}

export interface VideoUrlChangedMessage {
  type: 'VideoUrlChanged'
  payload: VideoUrlChangedPayload
}
```

Обновить union `ClientMessage` (добавить `SetVideoUrlMessage`) и `ServerMessage` (добавить `VideoUrlChangedMessage`).

### D.4 `useWebSocket` — обработка VideoUrlChanged

```ts
client.on('message:VideoUrlChanged', (p: VideoUrlChangedPayload) => {
  setVideoUrl(p.video_url)  // локальный state в хуке → прокидывается в RoomScreen
})
```

Или через `playbackSync.onVideoUrlChanged(url)` — если принять, что PlaybackSync обновляет свой `state.videoUrl`. Это проще: PlaybackSync и так хранит `videoUrl` в `PlaybackState`.

### D.5 React-компонент — управление адаптером

В `RoomScreen` (или выделить `PlayerContainer`):

```tsx
const containerRef = useRef<HTMLDivElement>(null)
const adapterRef = useRef<IPlayerAdapter | null>(null)

useEffect(() => {
  if (!videoUrl || !containerRef.current) return

  // Уничтожить старый адаптер
  adapterRef.current?.destroy()
  adapterRef.current = null

  // Создать новый
  try {
    const adapter = PlayerFactory.create(videoUrl, containerRef.current)
    adapterRef.current = adapter
    playbackSync?.setAdapter(adapter)
  } catch (e) {
    console.error('[PlayerContainer] Неизвестная платформа:', e)
  }

  return () => {
    adapterRef.current?.destroy()
    adapterRef.current = null
    playbackSync?.setAdapter(null)
  }
}, [videoUrl])

return (
  <div>
    <div ref={containerRef} style={{ width: '100%', aspectRatio: '16/9' }} />
    {/* Поле ввода URL */}
    <UrlInput onSubmit={(url) => ws.send({ type: 'SetVideoUrl', payload: { video_url: url } })} />
  </div>
)
```

### D.6 PlayerFactory — подключение RutubeAdapter

```ts
import { RutubeAdapter } from './RutubeAdapter'

static create(url: string, container: HTMLElement): IPlayerAdapter {
  const platform = detectPlatform(url)
  switch (platform) {
    case 'rutube': return new RutubeAdapter(url, container)
    default: throw new Error(`Адаптер для "${platform}" ещё не реализован`)
  }
}
```

### D.7 Индикатор «скорость не поддерживается»

В компоненте управления скоростью: если `state.videoUrl` → `PlayerFactory.detectPlatform(state.videoUrl) === 'rutube'` и выбран `rate !== 1.0` → показать текст `«RuTube не поддерживает изменение скорости»` рядом с селектором.

Это чисто UI: команда всё равно посылается (сервер принимает rate, другие адаптеры могут поддерживать), но для RuTube пользователь предупреждён визуально.

---

## E. Что отложить (TODO)

| Что | Почему отложено | Когда |
|---|---|---|
| VK Video адаптер | Требует загрузки внешнего JS-скрипта (`VK.VideoPlayer`); более сложная инициализация | После стабилизации RuTube |
| YouTube адаптер | Requires IFrame API загрузки через `<script>`, callback `onYouTubeIframeAPIReady` | После VK Video |
| Vimeo адаптер | Requires Vimeo Player SDK npm-пакет или CDN | После YouTube |
| Iframe-действия пользователя (пауза внутри плеера) | PlaybackSync не подписывается на события адаптера (§C.4). suppressionCount убран — добавим вместе с подпиской | Отдельная итерация: подписка + счётчик подавления |
| Обработка ошибок плеера (геоблок, 404) | Требует UI-нотификации; сейчас только `console.error` | После основного flow |
| Длительность видео (duration) → валидация Seek на сервере | Требует передачи duration от клиента на сервер | После стабилизации |
| `getCurrentTime` по запросу (не кэш) | Нужен Promise-based request-response через postMessage | При необходимости точной синхронизации |

---

## F. Обоснования для главы 2 диплома

### F.1 Почему postMessage, а не другие способы

Доступные способы управления видео в iframe стороннего хостинга:

| Способ | Применимость | Проблема |
|---|---|---|
| `<video>` элемент в своём DOM | Только для своего контента | Внешние хостинги не отдают сырой видеофайл |
| `iframe.contentDocument` | Работает только same-origin | Политика CORS/SOP запрещает — исключение `DOMException` |
| WebRTC screen capture | Захват экрана, не управление | Нет API управления, только чтение картинки |
| `postMessage` | Кросс-origin, стандарт HTML5 | Зависит от того, реализовал ли хостинг API |

`postMessage` — единственный стандартизированный механизм кросс-origin общения iframe с родительской страницей. Каждый хостинг реализует свой набор команд поверх него — именно это и нормализует паттерн «адаптер».

### F.2 Почему адаптер не наследует PlaybackSync, а инжектится

Альтернатива «`class RutubeSync extends PlaybackSync`» имеет недостатки:

1. **Нарушение SRP.** `PlaybackSync` отвечает за алгоритм синхронизации (timing, offset, execute_at). RuTube Adapter — за iframe API. Смешивание делает оба класса нетестируемыми в изоляции.
2. **Невозможна замена.** Если пользователь меняет URL с RuTube на YouTube — нужно создать новый адаптер, не пересоздавая PlaybackSync (который хранит NTP-offset-историю и pending-таймеры).
3. **Инверсия зависимостей.** PlaybackSync работает с `IPlayerAdapter` (абстракция), не с конкретным классом. При добавлении VK Video — нулевые изменения в PlaybackSync.
4. **Тестируемость.** PlaybackSync тестируется с mock-адаптером (`{ play: vi.fn(), pause: vi.fn(), ... }`). RutubeAdapter тестируется с mock-iframe. Без смешивания тесты просты.

### F.3 Почему URL — серверно-авторитетное состояние

Если URL хранился бы только на клиентах:
- Клиент A: `https://rutube.ru/video/aaa`
- Клиент B вводит: `https://rutube.ru/video/bbb` — кому верить?
- Без сервера: оба показывают разные видео и нет способа узнать «правильное».

С сервером: `SetVideoUrl` от B → сервер обновляет `session.video_url` → `VideoUrlChanged` летит всем → все переключаются на bbb. Конкурентный случай (A и B одновременно) — сервер сериализует, побеждает последний. Это предсказуемо.

Это продолжение принципа «сервер — единственный источник истины», применённого к state.video_url наравне с is_playing / position_ms.

---

## G. Порядок реализации по коммитам

### Коммит 1: Backend — `SetVideoUrl` + `VideoUrlChanged`
- `app/schemas/messages.py`: `SetVideoUrlMessage`, `VideoUrlChangedMessage` (два новых класса).
- `handler.py`: ветка `SetVideoUrl` — валидация, no-op, сброс is_playing/position_ms, broadcast.
- `docs/protocol.md`: добавить описание двух новых сообщений.
- **Видимый прогресс:** через DevTools WS можно отправить SetVideoUrl и увидеть VideoUrlChanged.

### Коммит 2: Frontend — типы + `useWebSocket` (приём VideoUrlChanged)
- `types/protocol.ts`: `SetVideoUrlMessage`, `VideoUrlChangedMessage`, обновление union-типов.
- `useWebSocket.ts`: обработка `message:VideoUrlChanged` → обновление state `videoUrl`.
- **Видимый прогресс:** смена URL через DevTools WS → фронт обновляет `videoUrl` в state.

### Коммит 3: `RutubeAdapter` + `PlayerFactory` + базовый UI с iframe
- `frontend/src/players/RutubeAdapter.ts`: полная реализация — iframe, postMessage, буферизация, `TIME_UNIT_MS`, логирование первого `player:currentTime`, warn для setPlaybackRate.
- `PlayerFactory.ts`: подключить RutubeAdapter (убрать заглушку).
- `App.tsx` (RoomScreen): URL-инпут, `<div ref={containerRef}>`, `useEffect` создающий/уничтожающий адаптер. PlaybackSync.setAdapter **не вызывается** — iframe появляется, но Play/Seek ещё не работают через адаптер.
- **Видимый прогресс:** вставить URL → iframe с RuTube видео появляется в комнате.
- **Остановиться:** прочитать в консоли первое `[RutubeAdapter] first player:currentTime: X` — определить единицу времени.

### Коммит 4: `PlaybackSync.setAdapter` + полная синхронизация
- `PlaybackSync.ts`: метод `setAdapter()` (race-safe), вызовы `adapter?.play/pause/seek/setPlaybackRate` в apply-функциях, конвертация мс→с.
- UI: `PlayerContainer` вызывает `playbackSync.setAdapter(adapter)`.
- Индикатор «RuTube не поддерживает скорость» рядом с селектором rate.
- **Видимый прогресс:** два клиента, один URL → Play/Seek работают синхронно через iframe.
- **Демонстрация:** показать синхронный Play и Seek на двух вкладках.

### Коммит 5: Финальная проверка + NOTES.md
- Ручной тест по всем критериям H.
- `NOTES.md`: раздел «Сессия 5 — адаптер RuTube».
- При необходимости — фикс-коммит по результатам.

---

## H. Критерии готовности

1. **Два клиента, один URL RuTube.** Открыть в двух вкладках одну комнату. Ввести одинаковый URL RuTube (или один ввёл — оба получили VideoUrlChanged). Оба отображают iframe с видео.

2. **Play.** Клик Play на клиенте A → через ≈200 мс оба iframe начинают воспроизведение. Визуально синхронно (рассинхрон между клиентами ≤ 500 мс в локальной сети — это допустимо для первого запуска, без нагрузочного теста).

3. **Seek.** Seek через UI на клиенте A → оба iframe перепрыгивают на заданную позицию.

4. **SetPlaybackRate ≠ 1.0.** Выбрать 1.5x → в консоли обоих клиентов `[RutubeAdapter] setPlaybackRate(1.5) не поддерживается`. В UI у обоих рядом с селектором скорости — текст-предупреждение. RuTube продолжает играть с rate=1.

5. **Смена URL.** Клиент A вводит новый URL → VideoUrlChanged → оба показывают новое видео, позиция сброшена в 0, пауза.

6. **TypeScript.** `npm run build` без ошибок. Никаких `any` в новых файлах.

7. **Регрессия.** `npm test` (playbackMath), `pytest` (test_session_state) — все зелёные.

8. **При отсутствии URL** (пустой videoUrl) — показывается заглушка «Введите ссылку на видео». Iframe не создаётся.

9. **Autoplay policy.** Первый `Play` может быть заблокирован браузером (Chrome/Firefox требуют user gesture перед `play()`). Это норма — пользователь нажимает кнопку Play в UI, что и является gesture. Если видео всё же не запускается — добавить `allow="autoplay"` к iframe атрибутам.

---

## Открытые вопросы для уточнения перед кодингом

1. **Единица в `player:setCurrentTime`** — секунды или мс? Нужно тестовое видео RuTube и DevTools для проверки фактического поведения embed API. Принять решение после проверки.

2. **Как фильтровать postMessage-события** — RuTube не гарантирует уникальный `origin` для всех вкладок (особенно при localhost). Фильтрация по `e.source === iframe.contentWindow` — достаточно, но нужно проверить, что CORS политика не блокирует.

3. **`suppressionCount` или `pendingCommandSet`** — обсудить, нужна ли более точная идентификация «наших» команд (по ID), если 200 мс таймаут окажется недостаточным.
