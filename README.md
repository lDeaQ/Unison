# ????????????????

Механизм синхронного воспроизведения мультимедиа-контента в распределённом веб-приложении.

Дипломный проект, СФУ, кафедра систем искусственного интеллекта, 2026.

## Суть

Открытый API синхронизации видеоплеера для нескольких пользователей в одной виртуальной комнате. Поддерживает несколько видеохостингов (RuTube, VK Video) через паттерн «адаптер плеера».

## Стек

- **Backend:** Python 3.11, FastAPI, uvicorn, SQLAlchemy 2 + aiosqlite, SQLite
- **Frontend:** React 18, Vite, TypeScript

## Быстрый старт

### Backend

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate        # Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Проверка: `GET http://localhost:8000/health`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Открыть: `http://localhost:5173`

## Структура

```
watchtogether/
├── backend/          # FastAPI-приложение
├── frontend/         # React + Vite + TypeScript
└── docs/
    └── protocol.md   # Спецификация протокола WebSocket
```

## Документация

Спецификация протокола WebSocket — [docs/protocol.md](docs/protocol.md).
