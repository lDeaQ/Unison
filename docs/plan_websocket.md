# План реализации WebSocket-инфраструктуры

## Файлы

**Создать:**
- `backend/app/schemas/messages.py`
- `backend/app/ws/manager.py`
- `backend/app/ws/router.py`
- `frontend/src/types/protocol.ts`
- `frontend/src/ws/WSClient.ts`
- `frontend/src/ws/useWebSocket.ts`

**Изменить:**
- `backend/app/main.py` — подключить новый роутер, убрать заглушку
- `frontend/src/App.tsx` — форма входа + список участников

---

## Backend

### `schemas/messages.py` — Pydantic-схемы

Каждое сообщение — дочерний класс `BaseMessage`:

```
BaseMessage
  type: str  ← discriminator для Literal

# Клиент → Сервер
HelloPayload       { session_id, nickname }
HelloMessage       type = Literal["Hello"]

# Сервер → Клиент
ParticipantInfo    { id, nickname, role }
WelcomePayload     { session_id, participants: list[ParticipantInfo] }
WelcomeMessage     type = Literal["Welcome"]

ParticipantJoinedMessage   type = Literal["ParticipantJoined"], payload: ParticipantInfo
ParticipantLeftMessage     type = Literal["ParticipantLeft"],   payload: { id, nickname }
ErrorMessage               type = Literal["Error"],             payload: { code, message }
```

Для разбора входящих сообщений — `Annotated` discriminated union через `type`:
```python
IncomingMessage = Annotated[HelloMessage | ..., Field(discriminator="type")]
```
Это даёт автоматическую валидацию с понятными ошибками вместо ручного `if msg["type"] == ...`.

---

### `ws/manager.py` — ConnectionManager

Хранилище:
```
_sessions: dict[str, dict[str, Entry]]
  session_id → user_id → { websocket, nickname, role, connected_at }
```

Методы:
- `connect(session_id, user_id, ws, nickname, role)` — добавляет запись
- `disconnect(session_id, user_id)` — удаляет запись; если сессия пуста — удаляет и её
- `broadcast(session_id, message, exclude_id=None)` — шлёт всем в сессии кроме exclude; каждый `send_text` обёрнут в `try/except` — упавший клиент не роняет рассылку
- `get_participants(session_id)` — список `ParticipantInfo` для Welcome
- `send(session_id, user_id, message)` — точечная отправка

Всё работает в одном asyncio event loop — блокировок не нужно, структура не шарится между потоками.

Роли: первый подключившийся к сессии получает `owner`, остальные — `participant`. Логика определяется в момент `connect` по факту существования сессии.

---

### `ws/router.py` — эндпоинт `/ws/{session_id}`

Последовательность:

1. `websocket.accept()`
2. Ждём первое сообщение с таймаутом **10 секунд** через `asyncio.wait_for`. Если таймаут — закрываем с кодом 4001 («Hello not received»).
3. Парсим через discriminated union. Если пришло не `Hello` или JSON сломан — шлём `ErrorMessage { code: "invalid_message" }`, закрываем с кодом 4002.
4. Генерируем `user_id = str(uuid4())`.
5. Вызываем `manager.connect(...)`.
6. Отправляем инициатору `Welcome` с текущим списком участников.
7. Рассылаем остальным `ParticipantJoined`.
8. Входим в `while True` — читаем сообщения. На этом этапе всё неизвестное просто логируется и игнорируется (остальные типы реализуются позже).
9. `except WebSocketDisconnect` → `manager.disconnect(...)` → рассылаем `ParticipantLeft` остальным.

Логируется: подключение (session_id, nickname, user_id), каждое полученное сообщение (тип + session_id), отключение.

---

## Frontend

### `types/protocol.ts` — TS-зеркало схем

Зеркалит Pydantic дословно. Основа — дискриминированный union:

```typescript
type ServerMessage =
  | WelcomeMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ErrorMessage

// каждый тип:
interface WelcomeMessage {
  type: 'Welcome'
  payload: WelcomePayload
}
```

Это позволяет использовать `switch (msg.type)` с исчерпывающей проверкой TypeScript.

---

### `ws/WSClient.ts` — WebSocket-клиент

**Состояния:**
```
IDLE → CONNECTING → CONNECTED → DISCONNECTING → IDLE
                 ↘ RECONNECTING ↗
```

**Reconnect с exponential backoff:**
- Задержки: 1 с → 2 с → 4 с → 8 с → 16 с → 30 с (cap)
- Jitter ±20% (умножаем на `0.8 + Math.random() * 0.4`) — чтобы несколько клиентов не штурмовали сервер одновременно
- После успешного подключения — сброс счётчика попыток
- Максимум попыток: не ограничен (переподключаемся бессрочно пока жив хук)

**Два вида разрыва:**
- `intentional = true` — вызов `disconnect()` из кода; переподключения нет
- `intentional = false` — `onclose`/`onerror` от браузера; запускается reconnect

**Сценарии ошибок:**

| Ситуация | Что происходит |
|---|---|
| Бэк недоступен при старте | `onerror` + `onclose` с кодом 1006 немедленно → переход в RECONNECTING → backoff-ожидание → повторная попытка |
| Бэк упал mid-session | Тот же путь: `onclose` → RECONNECTING → после восстановления автоматически шлётся `Hello` снова |
| Hello отклонён (таймаут 4001 или 4002) | `onclose` с соответствующим кодом → переходим в RECONNECTING, но если код `4002` (неверное сообщение, это наша ошибка) — не переподключаемся, эмитим событие `fatal_error` |
| Намеренный `disconnect()` | IDLE, никаких попыток |

**API класса:**
```typescript
class WSClient {
  connect(url: string, nickname: string, sessionId: string): void
  disconnect(): void
  send<T extends ClientMessage>(msg: T): void
  on(event: 'message' | 'status_change' | 'fatal_error', cb): void
  off(...)
  get status(): ConnectionStatus
}
```

После каждого reconnect клиент сам повторно шлёт `Hello` — nickname и sessionId хранятся внутри экземпляра.

---

### `ws/useWebSocket.ts` — React-хук

```typescript
function useWebSocket(sessionId: string, nickname: string) {
  // возвращает:
  return { status, participants, send, disconnect }
}
```

Внутри: создаёт `WSClient` один раз через `useRef`, подписывается на события через `useEffect`, обновляет `useState` для `status` и `participants`. На `onmessage`:
- `Welcome` → перезаписывает весь список участников
- `ParticipantJoined` → добавляет в список
- `ParticipantLeft` → удаляет по id

На unmount: `client.disconnect()`.

---

### `App.tsx` — обновлённый UI

**Два экрана:**

1. **Форма входа** (пока не подключён): поле nickname + кнопка «Войти». Session_id захардкожен как `"demo"`. Кнопка неактивна если nickname пустой.

2. **Комната** (после подключения): статус (`Подключение...` / `Подключено` / `Переподключение... (попытка N)`), список участников с никами и ролями, кнопка «Выйти».

Переход между экранами — по `status === 'connected'`.

---

## Итоговая демонстрация

Открываю два окна → ввожу «Иван» и «Мария» → нажимаю «Войти» в обоих → первый получает роль `owner`, второй `participant` → оба видят список `[Иван, Мария]`. Закрываю окно с «Мария» → у «Иван» список сразу становится `[Иван]`.
