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
