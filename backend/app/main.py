import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.db import init_db
from app.ws.handler import router as ws_router

# Heartbeat реализован на уровне uvicorn, не в коде приложения.
# Запускать с флагами: --ws-ping-interval 20 --ws-ping-timeout 10
# uvicorn отправляет WebSocket ping-фреймы каждые 20 сек;
# если pong не пришёл за 10 сек — соединение закрывается (~30 сек на обнаружение зависания).
# Браузеры отвечают на ping автоматически на уровне протокола, без JS-кода.


class _ContextFilter(logging.Filter):
    """Заполняет session_id и user_id значениями по умолчанию для записей без extra."""

    def filter(self, record: logging.LogRecord) -> bool:
        if not hasattr(record, "session_id"):
            record.session_id = "-"  # type: ignore[attr-defined]
        if not hasattr(record, "user_id"):
            record.user_id = "-"  # type: ignore[attr-defined]
        return True


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [session=%(session_id)s user=%(user_id)s] %(levelname)s %(name)s: %(message)s",
)
# Добавляем фильтр ко всем хендлерам корневого логгера
for _h in logging.getLogger().handlers:
    _h.addFilter(_ContextFilter())
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    logger.info("Database initialized")
    yield


app = FastAPI(
    title="WatchTogether API",
    version="0.1.0",
    description="Механизм синхронного воспроизведения мультимедиа",
    lifespan=lifespan,
)

app.include_router(ws_router)


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}
