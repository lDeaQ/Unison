# Plan: система ролей creator / admin / participant

## Контекст

Текущая система: две роли — `owner` (первый вошедший) и `participant`. Задача — расширить до трёх:

| Роль | Назначение | Управление видео | Управление ролями | Закрытие комнаты |
|---|---|---|---|---|
| `creator` | первый вошедший; передаётся автоматически при выходе | ✓ | ✓ назначить/снять admin | ✓ |
| `admin` | назначается creator | ✓ | ✗ | ✗ |
| `participant` | все остальные | ✗ | ✗ | ✗ |

Правило передачи роли creator при его выходе:
1. Старейший по времени назначения admin (тот, кто получил роль раньше других).
2. Если adminов нет — старейший participant (тот, кто вошёл раньше других).

Обратная совместимость: сессии со значением `owner` трактуются как `creator`.

---

## Шаг 1 — Протокол: новые сообщения

### 1.1 Клиент → Сервер

**`GrantAdmin`** — creator назначает участника admin.
```json
{ "type": "GrantAdmin", "payload": { "target_user_id": "u2" } }
```

**`RevokeAdmin`** — creator снимает роль admin.
```json
{ "type": "RevokeAdmin", "payload": { "target_user_id": "u2" } }
```

**`CloseRoom`** — creator закрывает комнату.
```json
{ "type": "CloseRoom", "payload": {} }
```

### 1.2 Сервер → Клиент

**`RoleChanged`** — широковещательно при смене роли любого участника (в том числе передача creator).
```json
{
  "type": "RoleChanged",
  "payload": {
    "user_id": "u2",
    "new_role": "admin",
    "reason": "granted"
  }
}
```

Допустимые значения `reason`: `"granted"` | `"revoked"` | `"creator_transferred"`.

**`RoomClosed`** — широковещательно перед разрывом всех соединений.
```json
{ "type": "RoomClosed", "payload": {} }
```

### 1.3 Новый код ошибки в `Error`

| Код | Закрывает соединение | Описание |
|---|---|---|
| `FORBIDDEN` | нет | Операция требует роли, которой у отправителя нет |
| `USER_NOT_FOUND` | нет | `target_user_id` не найден в сессии |

### 1.4 Изменения в существующих сообщениях

- `Welcome.participants[].role` — теперь `"creator" | "admin" | "participant"`.
- `ParticipantJoined.role` — аналогично.
- `ParticipantInfo` (Pydantic + TS) — аннотации обновить с `owner | participant` на `creator | admin | participant`.

---

## Шаг 2 — Backend: Pydantic-схемы (`messages.py`)

**Новые входящие схемы:**
- `GrantAdminPayload` / `GrantAdminMessage` — поле `target_user_id: str`
- `RevokeAdminPayload` / `RevokeAdminMessage` — поле `target_user_id: str`
- `CloseRoomPayload` / `CloseRoomMessage` — payload пустой (`pass`)

**Новые исходящие схемы:**
- `RoleChangedPayload` / `RoleChangedMessage` — поля `user_id: str`, `new_role: str`, `reason: str`
- `RoomClosedPayload` / `RoomClosedMessage` — payload пустой

**Изменения в существующих:**
- `ParticipantInfo.role: str` — обновить комментарий с `"owner" | "participant"` на `"creator" | "admin" | "participant"`
- `ErrorPayload.code` — добавить `FORBIDDEN`, `USER_NOT_FOUND` в аннотацию

---

## Шаг 3 — Backend: ConnectionManager (`manager.py`)

### 3.1 Структура данных

`ConnectedParticipant` — добавить поле:
```python
role_assigned_at: float  # server_now_ms() в момент назначения роли
                         # для creator: время входа; для admin: время GrantAdmin
```

`ConnectionManager._sessions` остаётся `dict[str, dict[str, ConnectedParticipant]]`. Порядок вставки в `dict` (CPython 3.7+) уже гарантирует хронологию для participant'ов — дополнительной структуры не нужно.

### 3.2 Изменения в `connect()`

```python
role = "creator" if not session else "participant"
participant.role_assigned_at = server_now_ms()
```

### 3.3 Новый метод `get_role(session_id, user_id) -> str | None`

Возвращает роль участника или `None` если не найден. Используется в handler.py для проверки прав.

### 3.4 Новый метод `set_role(session_id, user_id, role) -> bool`

Меняет роль участника in-place. Обновляет `role_assigned_at`. Возвращает `False` если участник не найден.

### 3.5 Новый метод `transfer_creator(session_id, departing_user_id) -> str | None`

Алгоритм:
1. Среди участников сессии, кроме `departing_user_id`, найти всех с ролью `admin`.
2. Если есть — выбрать с минимальным `role_assigned_at`. Назначить ему роль `creator`, обновить `role_assigned_at`.
3. Если нет — среди всех оставшихся участников выбрать с минимальным `role_assigned_at` (= вошедший первым). Назначить `creator`.
4. Вернуть `user_id` нового creator, либо `None` если сессия пуста.

Метод не рассылает сообщения — это делает handler.py.

### 3.6 Новые методы `grant_admin()` / `revoke_admin()`

```python
def grant_admin(self, session_id: str, requester_id: str, target_id: str) -> str | None
def revoke_admin(self, session_id: str, requester_id: str, target_id: str) -> str | None
```

Каждый:
1. Проверяет, что `requester` имеет роль `creator` → иначе возвращает `"FORBIDDEN"`.
2. Проверяет, что `target` существует → иначе `"USER_NOT_FOUND"`.
3. Для `grant_admin`: проверяет, что target не является `creator` (creator нельзя назначить admin).
4. Меняет роль через `set_role()`. Возвращает `None` при успехе.

Возвращаемое значение: `None` при успехе, код ошибки при неудаче. Handler.py использует это для отправки `ErrorMessage`.

---

## Шаг 4 — Backend: handler.py

### 4.1 Проверка прав для существующих команд

Добавить хелпер:
```python
def _check_can_control(role: str) -> bool:
    return role in ("creator", "admin")
```

В ветках `Play`, `Pause`, `Seek`, `SetPlaybackRate`, `SetVideoUrl` — в самом начале после парсинга добавить:
```python
if not _check_can_control(role):
    await websocket.send_text(_make_error("FORBIDDEN", "Недостаточно прав"))
    continue
```

Переменная `role` уже определена при входе (из `manager.connect()`). При смене роли через `RoleChanged` она в локальной переменной не обновляется — нужно читать из менеджера в момент проверки.

> **Уточнение:** `role` в хендлере определяется один раз при `connect()` и больше не обновляется. При смене роли через `GrantAdmin`/`RevokeAdmin`/`transfer_creator` менеджер обновляет внутреннее состояние, но локальная переменная `role` в корутине другого клиента остаётся старой. Поэтому проверку прав делать через `manager.get_role(session_id, user_id)`, а не через локальную `role`.

### 4.2 Новая ветка `GrantAdmin`

```
1. Распарсить GrantAdminMessage.
2. Вызвать manager.grant_admin(session_id, user_id, target_id).
3. Если ошибка → ErrorMessage.
4. Broadcast RoleChanged(target_id, "admin", "granted") всем в сессии.
5. Лог.
```

### 4.3 Новая ветка `RevokeAdmin`

```
1. Распарсить RevokeAdminMessage.
2. Вызвать manager.revoke_admin(session_id, user_id, target_id).
3. Если ошибка → ErrorMessage.
4. Broadcast RoleChanged(target_id, "participant", "revoked") всем в сессии.
5. Лог.
```

### 4.4 Новая ветка `CloseRoom`

```
1. Проверить роль через manager.get_role() == "creator" → иначе FORBIDDEN.
2. Broadcast RoomClosed всем в сессии (включая инициатора).
3. Закрыть все WebSocket-соединения в сессии через manager.close_all(session_id).
4. Лог.
```

Нужен новый метод `manager.close_all(session_id)`:
- Итерируется по копии словаря участников.
- Для каждого вызывает `websocket.close(1000)` в asyncio.gather (параллельно, игнорируя исключения).
- Удаляет сессию из `_sessions` и из `state_store`.

### 4.5 Изменения в блоке `finally` (отключение creator)

После `manager.disconnect(session_id, user_id)` добавить:

```python
if departing_role == "creator" and manager.session_has_members(session_id):
    new_creator_id = manager.transfer_creator(session_id, user_id)
    if new_creator_id:
        new_creator_nick = manager.get_nickname(session_id, new_creator_id)
        role_changed_msg = RoleChangedMessage(
            payload=RoleChangedPayload(
                user_id=new_creator_id,
                new_role="creator",
                reason="creator_transferred",
            )
        )
        await manager.broadcast(session_id, role_changed_msg.model_dump_json())
```

Нужен новый метод `manager.get_nickname(session_id, user_id) -> str | None`.

Переменную `departing_role` нужно сохранить до `disconnect()`, так как после удаления участника менеджер его данных не знает. Сохранить:
```python
departing_participant = manager.get_participant(session_id, user_id)  # новый метод
departing_role = departing_participant.role if departing_participant else "participant"
```

Или проще: сохранить `role` из `manager.connect()` в начале хендлера — она действительна как стартовая. Но роль могла смениться (participant → ничего, но creator → всегда creator, admin → мог стать creator). Надёжнее: читать через `manager.get_participant()` перед disconnect.

---

## Шаг 5 — Frontend: protocol.ts

Добавить новые типы:

```typescript
// Клиент → Сервер
export interface GrantAdminMessage {
  type: 'GrantAdmin'
  payload: { target_user_id: string }
}

export interface RevokeAdminMessage {
  type: 'RevokeAdmin'
  payload: { target_user_id: string }
}

export interface CloseRoomMessage {
  type: 'CloseRoom'
  payload: Record<string, never>
}

// Сервер → Клиент
export interface RoleChangedPayload {
  user_id: string
  new_role: 'creator' | 'admin' | 'participant'
  reason: 'granted' | 'revoked' | 'creator_transferred'
}

export interface RoleChangedMessage {
  type: 'RoleChanged'
  payload: RoleChangedPayload
}

export interface RoomClosedMessage {
  type: 'RoomClosed'
  payload: Record<string, never>
}
```

Изменения в существующих типах:
- `ParticipantInfo.role: 'creator' | 'admin' | 'participant'` (сейчас `string`).
- Добавить `RoleChangedMessage` и `RoomClosedMessage` в union `ServerMessage`.
- Добавить `GrantAdminMessage`, `RevokeAdminMessage`, `CloseRoomMessage` в union `ClientMessage`.

---

## Шаг 6 — Frontend: useWebSocket.ts

### 6.1 Новые поля в `UseWebSocketResult`

```typescript
myRole: 'creator' | 'admin' | 'participant' | null
roomClosed: boolean  // true → показать уведомление
sendGrantAdmin: (targetUserId: string) => void
sendRevokeAdmin: (targetUserId: string) => void
sendCloseRoom: () => void
```

### 6.2 Обработка `RoleChanged`

```typescript
client.on('message:RoleChanged', (payload) => {
  const p = payload as RoleChangedPayload
  setParticipants((prev) =>
    prev.map((part) =>
      part.id === p.user_id ? { ...part, role: p.new_role } : part
    )
  )
  // Обновляем свою роль, если изменилась наша
  if (p.user_id === myUserIdRef.current) {
    setMyRole(p.new_role)
  }
})
```

`myUserId` — вынести в `useRef` параллельно со `useState`, чтобы быть доступным внутри callback без замыканий на stale state.

### 6.3 Обработка `RoomClosed`

```typescript
client.on('message:RoomClosed', () => {
  setRoomClosed(true)
  client.disconnect()  // прекратить попытки реконнекта
})
```

### 6.4 Инициализация `myRole` из `Welcome`

В обработчике `message:Welcome` добавить:
```typescript
const myInfo = p.participants.find((pt) => pt.id === p.your_user_id)
setMyRole(myInfo?.role ?? 'participant')
```

---

## Шаг 7 — Frontend: UI

### 7.1 Иконки ролей в списке участников

| Роль | Иконка |
|---|---|
| `creator` | SVG корона, `fill: #ef4444` (красный, Tailwind red-500) |
| `admin` | SVG корона, `fill: #eab308` (жёлтый, Tailwind yellow-500) |
| `participant` | без иконки |

Компонент: `RoleBadge({ role })` — возвращает SVG или `null`. Встраивается в строку участника рядом с никнеймом.

Форма SVG короны — стандартная простая (5 зубцов), inline в JSX. Размер 16×16 px.

### 7.2 Кнопки управления видео

Кнопки Play/Pause/Seek/SetRate/SetVideoUrl — заблокировать (`disabled`) если `myRole === 'participant'`. Визуально: `opacity-50 cursor-not-allowed`. Без скрытия — блокировка, не удаление.

### 7.3 Контекстное меню участника (видно только creator)

Показывать рядом с каждым участником в списке (кроме самого creator) кнопки:
- «Назначить admin» — если участник `participant`
- «Снять admin» — если участник `admin`

Видимость условия: `myRole === 'creator'`.

Реализация: простая кнопка рядом с именем участника, без дропдауна.

### 7.4 Кнопка «Закрыть комнату»

Видна только если `myRole === 'creator'`. Размещение: нижняя часть панели участников или отдельная зона.

При клике — `window.confirm('Закрыть комнату? Все участники будут отключены.')` → если подтверждено → `sendCloseRoom()`.

### 7.5 Уведомление RoomClosed

Если `roomClosed === true` — показать overlay или alert: «Комната закрыта создателем» → кнопка «На главную» → навигация на экран входа (`/` или `/join`).

---

## Шаг 8 — Обратная совместимость

- В `manager.connect()` роль `"owner"` нигде не создаётся — создаётся сразу `"creator"`.
- Существующие сессии в памяти (`state_store`) содержат только игровое состояние, без ролей — роли живут в `ConnectionManager`. При рестарте сервера все сессии и так сбрасываются.
- `ParticipantInfo.role` в схеме меняется с `str` (комментарий `"owner" | "participant"`) на `str` (комментарий `"creator" | "admin" | "participant"`). Breaking change только документарный.

---

## Порядок реализации

1. **messages.py** — новые Pydantic-схемы (GrantAdmin, RevokeAdmin, CloseRoom, RoleChanged, RoomClosed) + обновить аннотации ParticipantInfo.
2. **manager.py** — поле `role_assigned_at`, методы `get_role`, `set_role`, `get_participant`, `get_nickname`, `grant_admin`, `revoke_admin`, `transfer_creator`, `close_all`; изменить `connect()`.
3. **handler.py** — проверка прав в Play/Pause/Seek/SetRate/SetVideoUrl; новые ветки GrantAdmin/RevokeAdmin/CloseRoom; логика передачи creator в `finally`.
4. **protocol.ts** — новые интерфейсы, обновить union-типы, уточнить `role` в `ParticipantInfo`.
5. **useWebSocket.ts** — новые поля результата, обработчики RoleChanged/RoomClosed, инициализация myRole из Welcome.
6. **UI** — компонент `RoleBadge`, блокировка кнопок, кнопки GrantAdmin/RevokeAdmin/CloseRoom, overlay RoomClosed.

---

## Открытые вопросы для согласования

1. **Роль creator при RevokeAdmin от самого себя:** если creator захочет сам снять с себя роль — возможно ли это? По текущему ТЗ — нет (роль неотчуждаема вручную). Подтвердить.

2. **Несколько creator:** текущая модель предполагает ровно одного creator на сессию всегда. Если хочется допустить сессию совсем без creator (все admin) — потребует отдельного обсуждения. Пока считаем: creator всегда ровно один.

3. **Что если target_user_id при GrantAdmin уже является creator?** — возвращать `FORBIDDEN` с сообщением «нельзя назначить admin пользователю с ролью creator». Это логично, поскольку creator имеет все права admin.

4. **Поведение admin при CloseRoom:** по ТЗ — `FORBIDDEN`. Подтвердить.
