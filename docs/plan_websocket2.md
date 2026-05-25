# План реализации WebSocket-инфраструктуры (v2)

## Цель

Реализовать полноценный обмен сообщениями между фронтом и бэком без NTP, плеера и БД.
Демонстрация готовности: два браузерных окна → разные ники → одна комната → список из двух
участников. Закрыть одно окно → второй участник исчезает.

---

## Файлы

| Файл | Действие | Суть |
|---|---|---|
| `backend/app/schemas/messages.py` | создать | Pydantic-схемы |
| `backend/app/ws/manager.py` | создать | ConnectionManager + NicknameTakenError |
| `backend/app/ws/handler.py` | создать | эндпоинт `/ws/{session_id}` |
| `backend/app/main.py` | изменить | подключить handler, убрать заглушку, добавить комментарий по heartbeat |
| `frontend/src/types/protocol.ts` | создать | TS-типы протокола (snake_case) |
| `frontend/src/ws/WSClient.ts` | создать | WS-клиент с exponential backoff |
| `frontend/src/ws/useWebSocket.ts` | создать | React-хук |
| `frontend/src/App.tsx` | изменить | два экрана + статус 'failed' + кнопка «Подключиться заново» |

---

## Бэкенд

### 1. `schemas/messages.py`

Каждое сообщение — Pydantic-модель с `type: Literal["..."]` и типизированным `payload`.
Базовый класс:

```python
class BaseMessage(BaseModel):
    type: str
```

Все имена полей в `payload` — **snake_case** (`is_playing`, `position_ms`, `playback_rate`,
`session_id`, `user_id`, `video_url`, `your_user_id`). Pydantic по умолчанию сохраняет имена
полей при сериализации — менять `alias` не нужно.

**Входящие (клиент → сервер):**

```python
class HelloPayload(BaseModel):
    session_id: str
    nickname: str

class HelloMessage(BaseModel):
    type: Literal["Hello"]
    payload: HelloPayload
```

**Исходящие (сервер → клиент):**

```python
class ParticipantInfo(BaseModel):
    id: str
    nickname: str
    role: str   # "owner" | "participant"

class WelcomePayload(BaseModel):
    session_id: str
    your_user_id: str           # ← ID этого клиента, чтобы он мог отличить себя в списке
    video_url: str              # "" для новой сессии
    is_playing: bool            # False для новой сессии
    position_ms: int            # 0 для новой сессии
    playback_rate: float        # 1.0 для новой сессии
    participants: list[ParticipantInfo]  # включает самого клиента

class WelcomeMessage(BaseModel):
    type: Literal["Welcome"] = "Welcome"
    payload: WelcomePayload

class ParticipantJoinedPayload(BaseModel):
    id: str
    nickname: str
    role: str

class ParticipantJoinedMessage(BaseModel):
    type: Literal["ParticipantJoined"] = "ParticipantJoined"
    payload: ParticipantJoinedPayload

class ParticipantLeftPayload(BaseModel):
    id: str
    nickname: str

class ParticipantLeftMessage(BaseModel):
    type: Literal["ParticipantLeft"] = "ParticipantLeft"
    payload: ParticipantLeftPayload

class ErrorPayload(BaseModel):
    code: str      # "HELLO_REQUIRED" | "INVALID_MESSAGE" | "NICKNAME_TAKEN"
    message: str   # человекочитаемое описание

class ErrorMessage(BaseModel):
    type: Literal["Error"] = "Error"
    payload: ErrorPayload
```

---

### 2. `ws/manager.py` — ConnectionManager

**Исключение для занятого ника:**

```python
class NicknameTakenError(Exception):
    pass
```

**Структура данных:**

```python
@dataclass
class ConnectedParticipant:
    user_id: str
    nickname: str
    role: str
    websocket: WebSocket

# хранилище (синглтон на уровне модуля):
_sessions: dict[str, dict[str, ConnectedParticipant]]
# session_id → { user_id → ConnectedParticipant }
```

Двухуровневый словарь — быстрое удаление по `user_id` без перебора.

**Методы:**

`connect(session_id: str, user_id: str, nickname: str, websocket: WebSocket) -> str`:
- Принимает `user_id` снаружи (генерируется в handler'е, не здесь).
- Проверяет уникальность ника в сессии:
  ```python
  if any(p.nickname == nickname for p in session.values()):
      raise NicknameTakenError(nickname)
  ```
- Роль: если сессия не существует или пуста → `"owner"`, иначе → `"participant"`.
- Добавляет участника, возвращает назначенную роль.

`disconnect(session_id: str, user_id: str) -> ConnectedParticipant | None`:
- Удаляет из словаря, возвращает удалённого участника (нужен для рассылки `ParticipantLeft`).
- Если сессия опустела — удаляет сессию целиком.

`get_participants(session_id: str) -> list[ParticipantInfo]`:
- Снимок для поля `participants` в `Welcome`.

`broadcast(session_id: str, message: str, exclude_user_id: str | None = None) -> None`:
- Итерирует по **копии** (`list(session.items())`), чтобы не падать при изменении словаря.
- При ошибке `send_text` собирает сломанные соединения в `failed: list[str]`.
- После итерации вызывает `disconnect()` для каждого из `failed` и логирует.
- Рассылку `ParticipantLeft` для "зомби"-соединений делает handler, не manager.

---

### 3. `ws/handler.py` — эндпоинт `/ws/{session_id}`

```
GET /ws/{session_id}  (WebSocket upgrade)
```

**Поток:**

```
1. websocket.accept()
2. Ждём первое сообщение — asyncio.wait_for(websocket.receive_text(), timeout=30)
   Таймаут → send ErrorMessage{"code":"HELLO_REQUIRED"}, close(4001), return
3. Парсим через HelloMessage.model_validate_json()
   ValidationError → send ErrorMessage{"code":"INVALID_MESSAGE"}, close(4002), return
4. user_id = str(uuid4())   ← генерируется здесь, не в manager
5. Пытаемся manager.connect(session_id, user_id, nickname, websocket)
   NicknameTakenError → send ErrorMessage{"code":"NICKNAME_TAKEN"}, close(4003), return
6. Отправляем Welcome этому клиенту:
   - your_user_id = user_id
   - participants = manager.get_participants(session_id)  # уже включает нового участника
   - дефолты для новой сессии: video_url="", is_playing=False, position_ms=0, playback_rate=1.0
7. Рассылаем ParticipantJoined всем остальным (exclude=user_id)
8. Основной цикл:
   while True:
     raw = await websocket.receive_text()
     Парсим type. Неизвестный тип → log WARNING, игнорируем (не закрываем соединение).
     WebSocketDisconnect → break
9. finally:
   participant = manager.disconnect(session_id, user_id)
   if participant and manager.session_has_members(session_id):
       await manager.broadcast(session_id, ParticipantLeft{id, nickname})
```

`finally` гарантирует очистку при любом завершении (исключение, обрыв, штатное закрытие).

---

### 4. `main.py` — изменения

- Удалить заглушку `/ws`.
- Подключить роутер из `handler.py`.
- Добавить комментарий о heartbeat:

```python
# Heartbeat реализован на уровне uvicorn (не приложения).
# Запускать с флагами: --ws-ping-interval 20 --ws-ping-timeout 10
# Это поддерживает соединение живым и позволяет uvicorn обнаружить
# зависшие соединения за ~30 секунд без кода в приложении.
```

---

### 5. Логирование

Настраиваем форматтер в `main.py` при старте:

```python
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [session=%(session_id)s user=%(user_id)s] %(levelname)s %(name)s: %(message)s",
    defaults={"session_id": "-", "user_id": "-"},
)
```

В handler'е передаём контекст через `extra`:

```python
log = logger.bind_extra(session_id=session_id, user_id=user_id)
# или через стандартный logging:
logger.info("Участник подключён", extra={"session_id": session_id, "user_id": user_id})
```

Каждая значимая точка логируется:
- `accept()` — INFO "Соединение принято"
- Hello получен — INFO "Hello от nickname"
- NicknameTakenError — WARNING "Ник занят: nickname"
- Welcome отправлен — INFO "Welcome отправлен"
- ParticipantJoined разослан — INFO "ParticipantJoined → N клиентов"
- Неизвестный тип — WARNING "Неизвестный тип сообщения: X"
- Отключение — INFO "Участник отключился"

---

### 6. Команда запуска бэкенда (обновлённая)

```bash
cd backend
uvicorn app.main:app --reload --port 8000 --ws-ping-interval 20 --ws-ping-timeout 10
```

Зафиксировать в `CLAUDE.md` в разделе «Полезные команды».

---

## Фронт

### 7. `types/protocol.ts`

Все поля — snake_case, соответствует Pydantic-схемам без преобразований:

```typescript
export interface ParticipantInfo {
  id: string
  nickname: string
  role: string
}

// Клиент → сервер
export interface HelloMessage {
  type: 'Hello'
  payload: {
    session_id: string
    nickname: string
  }
}

// Сервер → клиент
export interface WelcomePayload {
  session_id: string
  your_user_id: string      // ← ID этого клиента
  video_url: string
  is_playing: boolean
  position_ms: number
  playback_rate: number
  participants: ParticipantInfo[]
}
export interface WelcomeMessage          { type: 'Welcome';           payload: WelcomePayload }
export interface ParticipantJoinedMessage { type: 'ParticipantJoined'; payload: ParticipantInfo }
export interface ParticipantLeftMessage  { type: 'ParticipantLeft';   payload: { id: string; nickname: string } }
export interface ErrorMessage            { type: 'Error';             payload: { code: string; message: string } }

export type ServerMessage =
  | WelcomeMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ErrorMessage

export type ClientMessage = HelloMessage
```

---

### 8. `ws/WSClient.ts`

**Машина состояний:**

```
disconnected ──connect()──► connecting ──onopen──► connected
                                                       │
                              ◄──scheduleReconnect()───┘ (onclose аномальный)
                             reconnecting
                                  │
                          attempt > MAX(8)
                                  │
                              failed         ← новый терминальный статус
```

```typescript
export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'
```

**Хранимые данные:**

```typescript
private ws: WebSocket | null = null
private status: ConnectionStatus = 'disconnected'
private reconnectAttempt = 0
private reconnectTimer: ReturnType<typeof setTimeout> | null = null
private sessionId: string | null = null   // для переподключения
private nickname: string | null = null    // для переподключения
private deliberateClose = false           // true → не переподключаться
private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map()
```

**Методы:**

`connect(sessionId, nickname)` — сохраняет credentials, сбрасывает `deliberateClose = false`,
вызывает `openConnection()`.

`openConnection()` — `new WebSocket(url)`, вешает 4 обработчика.

`onopen` — сбрасывает `reconnectAttempt = 0`, устанавливает статус `'connected'`,
немедленно отправляет `HelloMessage`.

`onmessage(event)` — парсит JSON, эмиттирует `message:<type>` с payload.
При ошибке парсинга — log error, игнорирует.

`onclose(event)`:
```
if deliberateClose OR event.code === 1000:
    setStatus('disconnected')
    return
scheduleReconnect()
```

`onerror(event)` — log error, эмиттирует `'error'`. Закрытие придёт через `onclose`.

`scheduleReconnect()`:
```
reconnectAttempt++
if reconnectAttempt > 8:
    setStatus('failed')
    emit('max_retries_exceeded')
    return
delay = Math.min(1000 * 2 ** (reconnectAttempt - 1), 30_000)
// 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s
setStatus('reconnecting')
emit('reconnect_scheduled', { attempt: reconnectAttempt, delay_ms: delay })
reconnectTimer = setTimeout(() => openConnection(), delay)
```

`disconnect()` — `deliberateClose = true`, очищает таймер, `ws?.close(1000)`.

`send(message)` — проверяет `ws?.readyState === WebSocket.OPEN`, иначе log warning.

---

### 9. `ws/useWebSocket.ts`

```typescript
export type UseWebSocketResult = {
  status: ConnectionStatus
  participants: ParticipantInfo[]
  myUserId: string | null
  reconnect: () => void   // ← для кнопки при status === 'failed'
}

function useWebSocket(sessionId: string, nickname: string): UseWebSocketResult
```

**Логика:**

```typescript
useEffect(() => {
  const client = new WSClient()
  clientRef.current = client

  client.on('status_change', (s) => setStatus(s))
  client.on('message:Welcome', (payload: WelcomePayload) => {
    setMyUserId(payload.your_user_id)
    setParticipants(payload.participants)
  })
  client.on('message:ParticipantJoined', (payload: ParticipantInfo) =>
    setParticipants(prev => [...prev, payload])
  )
  client.on('message:ParticipantLeft', (payload) =>
    setParticipants(prev => prev.filter(p => p.id !== payload.id))
  )
  client.on('max_retries_exceeded', () => setStatus('failed'))

  client.connect(sessionId, nickname)
  return () => client.disconnect()
}, [sessionId, nickname])

// reconnect() — вызывает client.connect() заново, сбрасывает счётчик попыток
```

---

### 10. `App.tsx` — два экрана

**Экран 1 — Join:**
- Поле ввода nickname (валидация: непустое, ≤ 32 символов).
- Кнопка «Войти в комнату». `session_id = "demo"` захардкожен.
- Нажатие → `setJoined(true)`.

**Экран 2 — Room (joined === true):**
- Использует `useWebSocket("demo", nickname)`.
- Статус-бейдж:

| status | цвет | текст |
|---|---|---|
| `disconnected` | серый | Отключено |
| `connecting` | жёлтый | Подключение… |
| `reconnecting` | жёлтый | Переподключение, попытка N… |
| `connected` | зелёный | Подключено |
| `failed` | красный | Не удалось подключиться |

- При `status === 'failed'` — кнопка **«Подключиться заново»**, вызывает `reconnect()`.
- Список участников. Себя помечаем через `myUserId`: `(вы)` рядом с ником.
- Кнопка «Выйти» → `setJoined(false)`, хук размонтируется, клиент закрывает соединение с кодом 1000.

---

## Heartbeat

Реализуется **не в коде приложения**, а флагами uvicorn:

```
--ws-ping-interval 20   # ping каждые 20 сек
--ws-ping-timeout 10    # если pong не пришёл за 10 сек — закрыть соединение
```

Итого: зависшее соединение обнаруживается за ≤ 30 секунд.
Браузеры отвечают на ping автоматически (уровень WebSocket-фрейма, не приложения).

---

## Итоговая команда запуска бэкенда

```bash
cd backend
uvicorn app.main:app --reload --port 8000 --ws-ping-interval 20 --ws-ping-timeout 10
```

Зафиксировать в `CLAUDE.md` в разделе «Полезные команды».

---

## Что НЕ входит в эту итерацию

- NTP-синхронизация часов.
- Команды Play / Pause / Seek / SetPlaybackRate.
- Плееры и адаптеры.
- БД и логирование событий в SQLite.
- Аутентификация / роли модератора.
- Чат.
