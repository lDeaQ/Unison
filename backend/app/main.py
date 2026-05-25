import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from app.db import init_db

logging.basicConfig(level=logging.INFO)
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


@app.get("/health")
async def health_check() -> dict[str, str]:
    return {"status": "ok", "version": "0.1.0"}


@app.websocket("/ws")
async def websocket_stub(websocket: WebSocket) -> None:
    await websocket.accept()
    logger.info("WebSocket connection accepted")
    await websocket.send_text(json.dumps({"type": "connected", "payload": {}}))

    try:
        while True:
            raw = await websocket.receive_text()
            logger.info("Received: %s", raw)
            # Заглушка: эхо обратно с пометкой
            await websocket.send_text(
                json.dumps({"type": "echo", "payload": {"received": raw}})
            )
    except WebSocketDisconnect:
        logger.info("WebSocket connection closed")
