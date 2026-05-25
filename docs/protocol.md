# Протокол синхронизации WatchTogether

## Обзор

Взаимодействие между клиентом и сервером происходит по WebSocket-соединению на эндпоинте `/ws`.

Каждое сообщение — JSON-объект с обязательными полями:

```json
{
  "type": "<тип_сообщения>",
  "payload": { ... }
}
```

Сервер является единственным источником истины. Клиент не применяет действие локально до получения команды от сервера.

---

## Клиент → Сервер

### `Hello`
Присоединение к сессии.

```json
{
  "type": "Hello",
  "payload": {
    "session_id": "abc123",
    "nickname": "Иван"
  }
}
```

---

### `Play`
Пользователь нажал «Воспроизвести».

```json
{
  "type": "Play",
  "payload": {
    "position_ms": 45200
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `position_ms` | `int` | Текущая позиция клиента в миллисекундах |

---

### `Pause`
Пользователь нажал «Пауза».

```json
{
  "type": "Pause",
  "payload": {
    "position_ms": 45200
  }
}
```

---

### `Seek`
Перемотка на позицию.

```json
{
  "type": "Seek",
  "payload": {
    "position_ms": 120000
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `position_ms` | `int` | Целевая позиция в миллисекундах |

---

### `SetPlaybackRate`
Изменение скорости воспроизведения.

```json
{
  "type": "SetPlaybackRate",
  "payload": {
    "rate": 1.5
  }
}
```

| Поле | Тип | Допустимые значения |
|---|---|---|
| `rate` | `float` | `0.25`, `0.5`, `0.75`, `1.0`, `1.25`, `1.5`, `1.75`, `2.0` |

---

### `TimeSyncRequest`
NTP-подобный запрос для измерения смещения часов.

```json
{
  "type": "TimeSyncRequest",
  "payload": {
    "t0": 1716890000000
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `t0` | `int` | Клиентское время отправки (Unix ms) |

---

### `ChatMessage`
Текстовое сообщение в чат комнаты.

```json
{
  "type": "ChatMessage",
  "payload": {
    "text": "Привет всем!"
  }
}
```

---

## Сервер → Клиент

### `Welcome`
Отправляется сразу после подключения. Содержит текущее состояние сессии.

```json
{
  "type": "Welcome",
  "payload": {
    "session_id": "abc123",
    "video_url": "https://rutube.ru/video/...",
    "is_playing": false,
    "position_ms": 45200,
    "playback_rate": 1.0,
    "participants": [
      { "id": "u1", "nickname": "Иван", "role": "owner" }
    ]
  }
}
```

---

### `Play`
Широковещательная команда — начать воспроизведение.

```json
{
  "type": "Play",
  "payload": {
    "position_ms": 45200,
    "server_timestamp": 1716890001000,
    "execute_at": 1716890001200
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `position_ms` | `int` | Позиция, с которой начать воспроизведение |
| `server_timestamp` | `int` | Серверное время формирования команды (Unix ms) |
| `execute_at` | `int` | Серверное время применения команды (Unix ms, обычно `server_timestamp + 200`) |

---

### `Pause`
Широковещательная команда — поставить на паузу.

```json
{
  "type": "Pause",
  "payload": {
    "position_ms": 45200,
    "server_timestamp": 1716890001000,
    "execute_at": 1716890001200
  }
}
```

---

### `Seek`
Широковещательная команда — перемотать.

```json
{
  "type": "Seek",
  "payload": {
    "position_ms": 120000,
    "server_timestamp": 1716890001000,
    "execute_at": 1716890001200
  }
}
```

---

### `SetPlaybackRate`
Широковещательная команда — изменить скорость.

```json
{
  "type": "SetPlaybackRate",
  "payload": {
    "rate": 1.5,
    "server_timestamp": 1716890001000,
    "execute_at": 1716890001200
  }
}
```

---

### `TimeSyncResponse`
Ответ на `TimeSyncRequest`. Используется для расчёта смещения часов.

```json
{
  "type": "TimeSyncResponse",
  "payload": {
    "t0": 1716890000000,
    "t1": 1716890000045,
    "t2": 1716890000046
  }
}
```

Клиент записывает `t3 = Date.now()` при получении и вычисляет:

```
offset = ((t1 - t0) + (t2 - t3)) / 2
rtt    = (t3 - t0) - (t2 - t1)
```

Берётся медиана из последних 5 измерений. Измерения с RTT > медиана×2 отбрасываются.

---

### `ParticipantJoined`

```json
{
  "type": "ParticipantJoined",
  "payload": {
    "id": "u2",
    "nickname": "Мария",
    "role": "participant"
  }
}
```

---

### `ParticipantLeft`

```json
{
  "type": "ParticipantLeft",
  "payload": {
    "id": "u2",
    "nickname": "Мария"
  }
}
```

---

### `ChatMessage` (от сервера)

```json
{
  "type": "ChatMessage",
  "payload": {
    "id": "msg42",
    "user_id": "u1",
    "nickname": "Иван",
    "text": "Привет всем!",
    "timestamp": 1716890001000
  }
}
```

---

### `ChatModeration`
Уведомление об удалении сообщения модератором.

```json
{
  "type": "ChatModeration",
  "payload": {
    "message_id": "msg42",
    "action": "delete"
  }
}
```

---

## Компенсация задержки через `execute_at`

Сервер при рассылке команд Play/Pause/Seek/SetPlaybackRate добавляет поле `execute_at` — абсолютное серверное время, в которое команда должна применяться. Обычно `execute_at = server_timestamp + 200 мс`.

Клиент пересчитывает `execute_at` в локальное время:

```
local_execute_at = execute_at + clock_offset
delay_ms         = local_execute_at - Date.now()
```

Если `delay_ms > 0` — ставится таймер. Если `delay_ms < -50 мс` — команда применяется немедленно (опоздала).

Это гарантирует, что все участники применяют команду одновременно вне зависимости от их сетевой задержки.
