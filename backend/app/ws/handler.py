from __future__ import annotations

import asyncio
import json
import logging
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.schemas.messages import (
    ErrorMessage,
    ErrorPayload,
    HelloMessage,
    ParticipantJoinedMessage,
    ParticipantJoinedPayload,
    ParticipantLeftMessage,
    ParticipantLeftPayload,
    WelcomeMessage,
    WelcomePayload,
)
from app.ws.manager import NicknameTakenError, manager

logger = logging.getLogger(__name__)
router = APIRouter()

_HELLO_TIMEOUT_SEC = 30


def _make_error(code: str, message: str) -> str:
    return ErrorMessage(payload=ErrorPayload(code=code, message=message)).model_dump_json()


@router.websocket("/ws/{session_id}")
async def websocket_endpoint(websocket: WebSocket, session_id: str) -> None:
    await websocket.accept()
    logger.info(
        "Соединение принято",
        extra={"session_id": session_id, "user_id": "-"},
    )

    # 1. Ждём Hello — первое сообщение обязано быть Hello
    try:
        raw = await asyncio.wait_for(
            websocket.receive_text(), timeout=_HELLO_TIMEOUT_SEC
        )
    except asyncio.TimeoutError:
        await websocket.send_text(
            _make_error("HELLO_REQUIRED", "Ожидался Hello в течение 30 секунд")
        )
        await websocket.close(4001)
        return
    except WebSocketDisconnect:
        return

    # 2. Парсим Hello
    try:
        hello = HelloMessage.model_validate_json(raw)
    except ValidationError:
        await websocket.send_text(
            _make_error(
                "INVALID_MESSAGE",
                "Первое сообщение должно быть типа Hello с полями session_id и nickname",
            )
        )
        await websocket.close(4002)
        return

    nickname = hello.payload.nickname
    # user_id генерируется здесь — manager только принимает готовый ID
    user_id = str(uuid4())

    # 3. Регистрация в менеджере (проверка уникальности ника внутри)
    try:
        role = manager.connect(session_id, user_id, nickname, websocket)
    except NicknameTakenError:
        await websocket.send_text(
            _make_error(
                "NICKNAME_TAKEN",
                f"Ник '{nickname}' уже используется в этой комнате",
            )
        )
        await websocket.close(4003)
        return

    log_extra = {"session_id": session_id, "user_id": user_id}
    logger.info("Hello от '%s'", nickname, extra=log_extra)

    try:
        # 4. Welcome только этому клиенту
        welcome = WelcomeMessage(
            payload=WelcomePayload(
                session_id=session_id,
                your_user_id=user_id,
                video_url="",
                is_playing=False,
                position_ms=0,
                playback_rate=1.0,
                participants=manager.get_participants(session_id),
            )
        )
        await websocket.send_text(welcome.model_dump_json())
        logger.info("Welcome отправлен", extra=log_extra)

        # 5. ParticipantJoined всем остальным в сессии
        joined_msg = ParticipantJoinedMessage(
            payload=ParticipantJoinedPayload(id=user_id, nickname=nickname, role=role)
        )
        await manager.broadcast(
            session_id, joined_msg.model_dump_json(), exclude_user_id=user_id
        )
        participant_count = len(manager.get_participants(session_id))
        logger.info(
            "ParticipantJoined разослан (%d участников в комнате)",
            participant_count,
            extra=log_extra,
        )

        # 6. Основной цикл — получаем и логируем входящие сообщения
        while True:
            raw = await websocket.receive_text()
            try:
                parsed = json.loads(raw)
                msg_type = parsed.get("type", "<unknown>")
            except json.JSONDecodeError:
                msg_type = "<invalid json>"
            logger.warning(
                "Неизвестный тип сообщения: %s", msg_type, extra=log_extra
            )

    except WebSocketDisconnect:
        logger.info("Участник отключился: '%s'", nickname, extra=log_extra)
    finally:
        # Гарантированная очистка при любом завершении соединения
        participant = manager.disconnect(session_id, user_id)
        if participant and manager.session_has_members(session_id):
            left_msg = ParticipantLeftMessage(
                payload=ParticipantLeftPayload(id=user_id, nickname=nickname)
            )
            try:
                await manager.broadcast(session_id, left_msg.model_dump_json())
                logger.info("ParticipantLeft разослан", extra=log_extra)
            except Exception:
                logger.exception(
                    "Ошибка при рассылке ParticipantLeft", extra=log_extra
                )
