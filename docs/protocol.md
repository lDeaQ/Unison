# Протокол синхронизации WatchTogether

## Обзор

Взаимодействие между клиентом и сервером происходит по WebSocket-соединению на эндпоинте `/ws/{session_id}`.

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
Присоединение к сессии. Обязательно первым сообщением после установки соединения — в течение 30 секунд.

```json
{
  "type": "Hello",
  "payload": {
    "session_id": "abc123",
    "nickname": "Иван"
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `session_id` | `string` | Идентификатор комнаты |
| `nickname` | `string` | Никнейм участника; уникален в пределах сессии |

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
| `position_ms` | `int ≥ 0` | Текущая позиция клиента (диагностика; сервер в логике не использует) |

Сервер проверяет совпадение `position_ms` с собственным state и логирует расхождение. Если сессия уже воспроизводится — сервер отправляет no-op и бродкаст не делает.

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

| Поле | Тип | Описание |
|---|---|---|
| `position_ms` | `int ≥ 0` | Текущая позиция клиента (диагностика) |

Если сессия уже на паузе — no-op.

---

### `Seek`
Перемотка на позицию. Всегда рассылается широковещательно — даже при совпадении с текущей позицией.

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
| `position_ms` | `int ≥ 0` | Целевая позиция в миллисекундах |

---

### `SetPlaybackRate`
Изменение скорости воспроизведения. Всегда рассылается широковещательно.

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

При недопустимом значении сервер отвечает `Error` с кодом `INVALID_MESSAGE`.

---

### `TimeSyncRequest`
NTP-подобный запрос для измерения смещения часов клиента относительно сервера. Клиент шлёт периодически (~каждые 5 секунд).

```json
{
  "type": "TimeSyncRequest",
  "payload": {
    "client_send_ms": 12345.678
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `client_send_ms` | `float` | `performance.now()` в момент отправки (монотонные мс с субмиллисекундной точностью) |

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
Отправляется сразу после успешной обработки `Hello`. Содержит актуальное состояние сессии на момент отправки.

```json
{
  "type": "Welcome",
  "payload": {
    "session_id": "abc123",
    "your_user_id": "u1",
    "video_url": "https://rutube.ru/video/...",
    "is_playing": false,
    "position_ms": 45200,
    "playback_rate": 1.0,
    "participants": [
      { "id": "u1", "nickname": "Иван", "role": "owner" }
    ],
    "server_time_ms": 1716890001234.567
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `session_id` | `string` | Идентификатор комнаты |
| `your_user_id` | `string` | UUID этого клиента на сервере |
| `video_url` | `string` | URL текущего видео (`""` если не задан) |
| `is_playing` | `bool` | Состояние воспроизведения |
| `position_ms` | `int` | Позиция на момент `server_time_ms` |
| `playback_rate` | `float` | Текущая скорость |
| `participants` | `array` | Список всех участников в комнате |
| `server_time_ms` | `float` | Серверное Unix ms отправки Welcome |

`server_time_ms` используется клиентом для anchor-коррекции при `is_playing=true`:
если `ClockSync` уже измерил offset, то `anchorPerfNowMs = server_time_ms − offset`.
Иначе — fallback на `performance.now()` с возможной погрешностью ≈ RTT/2.

---

### `Play`
Широковещательная команда — начать воспроизведение. Отправляется инициатору и всем остальным участникам.

```json
{
  "type": "Play",
  "payload": {
    "position_ms": 45200,
    "server_timestamp_ms": 1716890001000.123,
    "execute_at_ms": 1716890001200.123
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `position_ms` | `int` | Позиция, с которой начать воспроизведение |
| `server_timestamp_ms` | `float` | Серверное Unix ms формирования команды |
| `execute_at_ms` | `float` | Серверное Unix ms применения (`server_timestamp_ms + 200`) |

---

### `Pause`
Широковещательная команда — поставить на паузу.

```json
{
  "type": "Pause",
  "payload": {
    "position_ms": 45200,
    "server_timestamp_ms": 1716890001000.123,
    "execute_at_ms": 1716890001200.123
  }
}
```

`position_ms` — позиция, зафиксированная на момент `execute_at_ms` (вычислена сервером по anchor-формуле).

---

### `Seek`
Широковещательная команда — перемотать.

```json
{
  "type": "Seek",
  "payload": {
    "position_ms": 120000,
    "server_timestamp_ms": 1716890001000.123,
    "execute_at_ms": 1716890001200.123
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
    "position_ms": 46500,
    "server_timestamp_ms": 1716890001000.123,
    "execute_at_ms": 1716890001200.123
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `rate` | `float` | Новая скорость |
| `position_ms` | `int` | Позиция на момент `execute_at_ms` по **старому** rate — обеспечивает непрерывность |
| `server_timestamp_ms` | `float` | Серверное Unix ms формирования команды |
| `execute_at_ms` | `float` | Серверное Unix ms применения |

Поле `position_ms` присутствует именно в `SetPlaybackRate` (но не в `Play`), так как смена скорости нарушает локальную anchor-формулу клиента: без явной позиции клиент должен был бы самостоятельно интегрировать старый rate до `execute_at_ms`. Сервер передаёт готовый результат.

---

### `TimeSyncResponse`
Ответ на `TimeSyncRequest`. Используется для расчёта смещения часов клиента.

```json
{
  "type": "TimeSyncResponse",
  "payload": {
    "client_send_ms": 12345.678,
    "server_receive_ms": 1716890000045.1,
    "server_send_ms": 1716890000045.3
  }
}
```

| Поле | Тип | Описание |
|---|---|---|
| `client_send_ms` | `float` | Эхо `client_send_ms` из запроса |
| `server_receive_ms` | `float` | Серверное Unix ms приёма запроса (фиксируется сразу после `receive_text`) |
| `server_send_ms` | `float` | Серверное Unix ms перед `send_text` ответа |

Клиент фиксирует `t3 = performance.now()` при получении и вычисляет:

```
offset = ((server_receive_ms − client_send_ms) + (server_send_ms − t3)) / 2
rtt    = (t3 − client_send_ms) − (server_send_ms − server_receive_ms)
```

После этого: `performance.now() + offset ≈ server_now_ms()`.

Берётся медиана из последних 8 измерений. Измерения из верхнего квартиля по RTT отбрасываются (trim 25%).

---

### `ParticipantJoined`
Рассылается всем участникам, кроме нового, при его подключении.

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
Рассылается при отключении участника.

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

### `Error`
Ответ на невалидный запрос клиента. Соединение не закрывается, если не указано иное.

```json
{
  "type": "Error",
  "payload": {
    "code": "INVALID_MESSAGE",
    "message": "Play: ожидается payload.position_ms (int, ≥0)"
  }
}
```

| Код | Закрывает соединение | Описание |
|---|---|---|
| `HELLO_REQUIRED` | да (4001) | Первое сообщение не было `Hello` или таймаут 30 сек |
| `INVALID_MESSAGE` | нет | Тело сообщения не прошло валидацию Pydantic |
| `NICKNAME_TAKEN` | да (4003) | Никнейм уже занят в этой комнате |

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

## Компенсация задержки через `execute_at_ms`

Сервер при рассылке команд Play/Pause/Seek/SetPlaybackRate добавляет поле `execute_at_ms` — абсолютное серверное Unix ms, в которое команда должна примениться. Обычно `execute_at_ms = server_timestamp_ms + 200`.

Клиент пересчитывает `execute_at_ms` в локальное `performance.now()`-время:

```
local_execute_at = execute_at_ms − clock_offset
delay_ms         = local_execute_at − performance.now()
```

Если `delay_ms > 0` — ставится `setTimeout`. Если `delay_ms ∈ (−50, 0]` — команда применяется немедленно. Если `delay_ms < −50` — команда сильно опоздала: применяется немедленно, в консоли — `[PlaybackSync] X late by N ms`.

Это гарантирует, что все участники применяют команду одновременно вне зависимости от их сетевой задержки.

---

## Anchor-формула позиции

Серверный state определяется четвёркой `(is_playing, position_ms, anchor_server_ms, playback_rate)`. Текущая позиция в любой момент вычисляется детерминированно:

```
position_at(now_ms) = position_ms + (now_ms − anchor_server_ms) × playback_rate   если is_playing
position_at(now_ms) = position_ms                                                    иначе
```

Клиент хранит аналогичную структуру, но `anchor_server_ms` заменяется на `anchorPerfNowMs` — через `execute_at_ms − clock_offset`. Между командами рассылок нет: клиенты вычисляют позицию самостоятельно по той же формуле.
