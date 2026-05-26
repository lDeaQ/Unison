# Заметки по проекту

## Сессия 1 — 25.05.2026

### Что сделано

1. **Разобрали контекст проекта** — прочитали CLAUDE.md, зафиксировали стек, архитектурные решения и суть адаптеров плееров.

2. **Создали скелет проекта:**
   - `backend/` — FastAPI с `GET /health` → `{"status":"ok","version":"0.1.0"}`, WebSocket-заглушка `/ws` (echo), инициализация SQLite через aiosqlite (`app/db.py`), пустые пакеты под все модули (`api/`, `ws/`, `sync/`, `models/`, `schemas/`, `services/`).
   - `frontend/` — Vite + React 18 + TypeScript, упрощённый `App.tsx` (заголовок + статус), прокси `/api` и `/ws` → `localhost:8000` в `vite.config.ts`, интерфейс `IPlayerAdapter` с базовым классом, заглушка `PlayerFactory` с определением платформы по URL.
   - `docs/protocol.md` — полная спецификация протокола WebSocket: все типы сообщений клиент↔сервер с примерами JSON, описание `execute_at` и NTP-формулы.
   - `README.md` — краткое описание проекта и команды запуска.

3. **Сделали первый коммит** `b3ec49f` — 36 файлов, 1186 строк.

4. **Подняли бэкенд:** установили зависимости в `.venv`, запустили `uvicorn app.main:app --reload --port 8000`. Сервер стартует, БД инициализируется, `/health` отвечает 200.

### Что ещё не сделано (следующие шаги)

- `npm install` и запуск фронтенда (`npm run dev`).
- Pydantic-схемы сообщений протокола (`backend/app/schemas/`) — `Play`, `Pause`, `Seek`, `SetPlaybackRate`, `Hello`, `Welcome`, `TimeSyncRequest/Response` и др.
- SQLAlchemy-модели (`sessions`, `users`, `events_log`, `chat_messages`).
- Настоящий WebSocket-обработчик с `SessionManager` вместо echo-заглушки.
- Реализация адаптеров плееров: `RutubeAdapter`, `VKVideoAdapter` (приоритет), затем `YouTubeAdapter`, `VimeoAdapter`.
- Алгоритм NTP-синхронизации на клиенте (`frontend/src/sync/`).
- Применение команд с компенсацией задержки через `execute_at`.
- REST-эндпоинты: создание комнаты, получение списка участников.
- Юнит-тесты алгоритма синхронизации.
- Интеграционные тесты WebSocket-сценариев.
- Нагрузочный скрипт (эмуляция 30+ клиентов, измерение рассинхрона).

---

## Сессия 2 — WebSocket-инфраструктура (завершена)

### Сделано

- Pydantic-схемы сообщений в `backend/app/schemas/messages.py` (Hello, Welcome, ParticipantJoined, ParticipantLeft, Error). Все поля в snake_case.
- ConnectionManager в `backend/app/ws/manager.py`: проверка уникальности ника через `NicknameTakenError`, безопасная итерация при `broadcast`, автоматическое назначение роли (`owner` — первому в сессии, `participant` — остальным).
- WebSocket-эндпоинт `/ws/{session_id}` в `backend/app/ws/handler.py`: поток `accept → Hello → Welcome → broadcast ParticipantJoined → loop → ParticipantLeft` в `finally`.
- Логирование с контекстом `[session=X user=Y]`: использован кастомный `_ContextFilter` в `backend/app/main.py` (параметр `defaults` в `logging.basicConfig` не работает в Python 3.14 — fallback на фильтр).
- Heartbeat настроен на уровне uvicorn флагами `--ws-ping-interval 20 --ws-ping-timeout 10`, не на уровне приложения.
- TypeScript-типы протокола в `frontend/src/types/protocol.ts` — зеркало Pydantic-схем.
- `WSClient` в `frontend/src/ws/WSClient.ts`: машина состояний `disconnected → connecting → connected → reconnecting → failed`, exponential backoff 1/2/4/8/16/30/30/30 сек, `deliberateClose` флаг для отличия штатного выхода от обрыва.
- React-хук `useWebSocket` в `frontend/src/ws/useWebSocket.ts`.
- `App.tsx` с двумя экранами (Join и Room), цветными статус-бейджами, пометкой "(вы)" по `myUserId`, кнопкой "Подключиться заново" при `status === 'failed'`.

### Проверено вручную (4 сценария — все прошли)

- **Одиночное подключение:** зелёный статус, один участник в списке.
- **Два пользователя в одной комнате:** оба видят друг друга, обновление списка без перезагрузки.
- **Отключение:** при закрытии окна участник исчезает у других через ~секунду.
- **Занятый ник:** сервер шлёт `Error` с кодом `NICKNAME_TAKEN` и закрывает соединение с кодом 4003, фронт делает 8 попыток переподключения, затем переходит в статус `failed`.

### Окружение

- Python 3.14 (нестандартно свежий — следить за совместимостью пакетов).
- Node.js + Vite + React 18 + TypeScript.
- Бэкенд: `cd Z:\DIPLOMw2t\backend` → `.venv\Scripts\activate` → `uvicorn app.main:app --reload --port 8000 --ws-ping-interval 20 --ws-ping-timeout 10`
- Фронт: `cd Z:\DIPLOMw2t\frontend` → `npm run dev` (открывается на `localhost:5173`).

---

## TODO (известные улучшения, отложены)

### UX при NICKNAME_TAKEN

Сейчас при занятом нике фронт честно отрабатывает машину состояний: 8 попыток переподключения (≈100 секунд суммарно) → `failed` → кнопка "Подключиться заново". Это технически правильно, но пользователю бесполезно: ник занят навсегда, переподключение не поможет.

**Что сделать:** `WSClient` должен запоминать последнюю полученную `Error` от сервера. При коде `NICKNAME_TAKEN` — НЕ запускать `scheduleReconnect`, а сразу переводить статус в специальный `'nickname_taken'` (или просто `'failed'` с дополнительным флагом `reason`). В `App.tsx` показывать понятное сообщение "Этот ник уже занят, выберите другой" и кнопку "Назад к выбору ника" вместо "Подключиться заново".

Это задача на этап полировки UI ближе к концу разработки, не сейчас.

---

## Сессия 3 — NTP-синхронизация часов (завершена) — 26.05.2026

### Сделано

- **План.** `docs/plan_ntp.md` — полная декомпозиция с обоснованиями для главы 2 диплома (N=8, trim 25%, медиана vs среднее, performance.now vs Date.now, источник серверного времени).
- **Бэкенд.**
  - `app/sync/clock.py::server_now_ms()` — единая точка серверного времени (`time.time() * 1000`).
  - Схемы `TimeSyncRequestMessage` / `TimeSyncResponseMessage` в `app/schemas/messages.py` — все метки float (мс с дробной частью).
  - В `app/ws/handler.py`: t1 фиксируется сразу после `receive_text()` (до парсинга/валидации), t2 — прямо перед `send_text()`. Невалидный TimeSync → `Error INVALID_MESSAGE` без закрытия сессии. Логи TimeSync на уровне DEBUG.
- **Фронт.**
  - `frontend/src/sync/clockMath.ts` — чистые функции: `computeOffsetMs`, `computeRttMs`, `makeMeasurement`, `median`, `selectBestOffset` (trim 25% верха по RTT + медиана offset), `offsetUncertaintyMs` (`(medianRtt - minRtt) / 2` — верхняя оценка погрешности).
  - `frontend/src/sync/ClockSync.ts` — класс с warmup-фазой (5×1 сек, потом 5 сек), окном 8, защитой от гонок через флаг `running`, фиксацией `firstOffset` для расчёта дрейфа. Публичный API: `getServerTime`, `getOffset`, `getOffsetDriftMs`, `getRtt` (медиана окна), `getLastRtt`, `getOffsetUncertaintyMs`, `getMeasurementCount`, `isReady` + событие `updated`.
  - `frontend/src/sync/useClockSync.ts` — тонкий React-хук, мост между ClockSync и состоянием компонента.
  - Интеграция в `useWebSocket`: ClockSync создаётся рядом с WSClient, на `connected` → `reset()` + `start()`, на `disconnected`/`reconnecting` → `stop()`. На `message:Error` — `console.warn` и продолжаем.
  - Vitest подключён, 20 тестов в `clockMath.test.ts` все зелёные, включая stability test на 1000 синтетических измерений с 10% выбросами (seed=42, 993/993 проверок прошли).
- **UI-индикатор** в RoomScreen: `Sync: drift +0.X мс ±0.X мс | RTT X.X мс | n=N`. Драфт показывается вместо абсолютного offset (offset = wall_clock_ms − performance.now()_ms ≈ 1.7e12, неудобно глазами). Цвет RTT: зелёный <50 мс / жёлтый <150 мс / красный иначе.
- **`scripts/verify_ntp.mjs`** — dev-утилита (вне продакшен-сборки) для ручной проверки реального TimeSync-обмена с бэкендом. Использует встроенный `globalThis.WebSocket` (Node 22+), повторяет формулы clockMath inline.

### Проверено (реальный round-trip против бэкенда)

| Сценарий              | drift финальный | uncertainty | medianRTT |
|-----------------------|-----------------|-------------|-----------|
| Один клиент           | 0.106 мс        | ±0.328 мс   | 1.083 мс  |
| alice (параллельно)   | 0.082 мс        | ±0.124 мс   | 0.816 мс  |
| bob (параллельно)     | 0.190 мс        | ±0.169 мс   | 0.819 мс  |

**Рассинхрон между `getServerTime()` alice и bob: 0.043 мс** — субмиллисекундная синхронизация на localhost. Целевой показатель ≤ 50 мс из ТЗ перекрыт с большим запасом; на реальной сети будет хуже, но запас огромный.

### Известные TODO (отложено)

- **Мягкий сброс при быстром реконнекте** (< 60 сек с последнего измерения) — сохранять offset как стартовое, пропускать warmup. См. `docs/plan_ntp.md §9` и TODO-комментарий в `ClockSync.ts::reset()`.
- **UX при NICKNAME_TAKEN** (наследие сессии 2) — не делать 8 попыток реконнекта, сразу показывать «выберите другой ник».

---

## Следующая сессия — команды Play/Pause/Seek с execute_at

Теперь, когда есть точные часы, можно реализовать главное:

- Схемы `Play`/`Pause`/`Seek`/`SetPlaybackRate` (клиент → сервер: payload с позицией/скоростью; сервер → клиент: + `server_timestamp` + `execute_at`).
- Серверная логика: при получении команды формирует широковещание с `execute_at = server_now_ms() + 200`, рассылает всем включая инициатора.
- Клиентская: пересчёт `execute_at` в локальное время через `ClockSync.getOffset()`, `setTimeout` на применение, обработка опоздавших команд (если `delay_ms < -50` — применять немедленно).
- Стейт сессии на бэке: текущие is_playing/position_ms/playback_rate, обновляются по командам, отдаются в Welcome.
- На фронте — пока без реального плеера (адаптеры — следующая итерация). Просто визуализировать состояние: «idle / playing с позиции X мс / на паузе на X мс / playback rate X».
- Юнит-тесты на расчёт `local_execute_at` и поздних команд.

После этого этапа можно приступать к адаптерам плееров (RuTube + VK Video в приоритете).
