"""Запись событий сессии в БД.

Все функции оборачивают DB-операции в try/except — ошибка логирования
не должна ронять WebSocket-соединение.
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from datetime import datetime, timezone

from app.db import AsyncSessionLocal
from app.models.events import EventLog
from app.models.session import Session, User
from app.services.session_state import SessionState
from app.sync.clock import server_now_ms

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def log_join(
    session_id: str,
    user_id: str,
    nickname: str,
    role: str,
    state: SessionState,
) -> None:
    try:
        async with AsyncSessionLocal() as db:
            now = _utcnow()
            now_ms = server_now_ms()

            # Upsert сессии: создаём если нет, иначе обновляем video_url + current_state
            existing_session = await db.get(Session, session_id)
            if existing_session is None:
                db.add(
                    Session(
                        id=session_id,
                        created_at=now,
                        video_url=state.video_url,
                        owner_id=user_id if role == "owner" else None,
                        current_state=asdict(state),
                    )
                )
            else:
                existing_session.video_url = state.video_url
                existing_session.current_state = asdict(state)
                if role == "owner" and existing_session.owner_id is None:
                    existing_session.owner_id = user_id

            # Новый пользователь
            db.add(
                User(
                    id=user_id,
                    session_id=session_id,
                    nickname=nickname,
                    role=role,
                    joined_at=now,
                )
            )

            # Событие Join
            db.add(
                EventLog(
                    session_id=session_id,
                    user_id=user_id,
                    event_type="Join",
                    server_timestamp_ms=now_ms,
                    payload={"nickname": nickname, "role": role},
                )
            )

            await db.commit()
    except Exception:
        logger.exception(
            "Ошибка логирования Join session=%s user=%s", session_id, user_id
        )


async def log_leave(
    session_id: str,
    user_id: str,
) -> None:
    try:
        async with AsyncSessionLocal() as db:
            now = _utcnow()
            now_ms = server_now_ms()

            user = await db.get(User, user_id)
            if user is not None:
                user.left_at = now

            db.add(
                EventLog(
                    session_id=session_id,
                    user_id=user_id,
                    event_type="Leave",
                    server_timestamp_ms=now_ms,
                )
            )

            await db.commit()
    except Exception:
        logger.exception(
            "Ошибка логирования Leave session=%s user=%s", session_id, user_id
        )


async def log_command(
    session_id: str,
    user_id: str,
    event_type: str,
    server_timestamp_ms: float,
    payload: dict | None = None,
) -> None:
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                EventLog(
                    session_id=session_id,
                    user_id=user_id,
                    event_type=event_type,
                    server_timestamp_ms=server_timestamp_ms,
                    payload=payload,
                )
            )
            await db.commit()
    except Exception:
        logger.exception(
            "Ошибка логирования %s session=%s user=%s",
            event_type, session_id, user_id,
        )


async def log_time_sync(
    session_id: str,
    user_id: str,
    server_receive_ms: float,
    server_send_ms: float,
) -> None:
    """Логирует TimeSyncResponse. latency_ms = время серверной обработки."""
    processing_ms = server_send_ms - server_receive_ms
    try:
        async with AsyncSessionLocal() as db:
            db.add(
                EventLog(
                    session_id=session_id,
                    user_id=user_id,
                    event_type="TimeSyncResponse",
                    server_timestamp_ms=server_receive_ms,
                    latency_ms=processing_ms,
                )
            )
            await db.commit()
    except Exception:
        logger.exception(
            "Ошибка логирования TimeSyncResponse session=%s user=%s",
            session_id, user_id,
        )
