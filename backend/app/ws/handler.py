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
    PauseBroadcastMessage,
    PauseBroadcastPayload,
    PauseRequestMessage,
    PlayBroadcastMessage,
    PlayBroadcastPayload,
    PlayRequestMessage,
    SeekBroadcastMessage,
    SeekBroadcastPayload,
    SeekRequestMessage,
    SetPlaybackRateBroadcastMessage,
    SetPlaybackRateBroadcastPayload,
    SetPlaybackRateRequestMessage,
    SetVideoUrlMessage,
    TimeSyncRequestMessage,
    TimeSyncResponseMessage,
    TimeSyncResponsePayload,
    VideoUrlChangedMessage,
    VideoUrlChangedPayload,
    WelcomeMessage,
    WelcomePayload,
)
from app.services.event_logger import (
    log_command,
    log_join,
    log_leave,
    log_time_sync,
)
from app.services.session_state import (
    apply_pause,
    apply_play,
    apply_seek,
    apply_set_rate,
    apply_set_video_url,
    compute_current_position_ms,
    state_store,
)
from app.sync.clock import EXECUTE_AT_DELAY_MS, server_now_ms
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
        # 4. Welcome только этому клиенту — с актуальным состоянием сессии
        session_state = state_store.get_or_create(session_id)
        now = server_now_ms()
        welcome = WelcomeMessage(
            payload=WelcomePayload(
                session_id=session_id,
                your_user_id=user_id,
                video_url=session_state.video_url,
                is_playing=session_state.is_playing,
                position_ms=compute_current_position_ms(session_state, now),
                playback_rate=session_state.playback_rate,
                participants=manager.get_participants(session_id),
                server_time_ms=now,
            )
        )
        await websocket.send_text(welcome.model_dump_json())
        logger.info("Welcome отправлен", extra=log_extra)

        # Логируем Join в БД (после отправки Welcome — не блокируем handshake)
        await log_join(session_id, user_id, nickname, role, session_state)

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

        # 6. Основной цикл — получаем и обрабатываем входящие сообщения
        while True:
            raw = await websocket.receive_text()
            # t1_candidate фиксируется как можно раньше — до JSON-разбора и валидации
            # Pydantic. Используется только если сообщение окажется TimeSyncRequest;
            # на остальных типах значение просто отбрасывается. Делаем так, чтобы
            # не включать в t1 время на сериализацию/валидацию (десятки–сотни мкс).
            t1_candidate = server_now_ms()
            try:
                parsed = json.loads(raw)
                msg_type = parsed.get("type", "<unknown>")
            except json.JSONDecodeError:
                logger.warning("Невалидный JSON во входящем сообщении", extra=log_extra)
                continue

            if msg_type == "TimeSyncRequest":
                try:
                    req = TimeSyncRequestMessage.model_validate(parsed)
                except ValidationError:
                    # Не закрываем соединение из-за одной кривой метки —
                    # шлём Error и продолжаем работать.
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "TimeSyncRequest: ожидается payload.client_send_ms (float)",
                        )
                    )
                    continue

                # t2 фиксируется в самый последний момент — прямо перед send_text,
                # чтобы в server_send_ms попала минимально возможная задержка.
                response = TimeSyncResponseMessage(
                    payload=TimeSyncResponsePayload(
                        client_send_ms=req.payload.client_send_ms,
                        server_receive_ms=t1_candidate,
                        server_send_ms=server_now_ms(),
                    )
                )
                await websocket.send_text(response.model_dump_json())
                logger.debug("TimeSync обработан", extra=log_extra)
                continue

            if msg_type == "Play":
                try:
                    req = PlayRequestMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "Play: ожидается payload.position_ms (int, ≥0)",
                        )
                    )
                    continue

                server_now = server_now_ms()
                execute_at = server_now + EXECUTE_AT_DELAY_MS
                old_state = state_store.get_or_create(session_id)
                new_state = apply_play(old_state, execute_at)

                if new_state is old_state:
                    logger.info("Play (no-op, уже воспроизводится)", extra=log_extra)
                    continue

                state_store.set(session_id, new_state)
                broadcast_msg = PlayBroadcastMessage(
                    payload=PlayBroadcastPayload(
                        position_ms=new_state.position_ms,
                        server_timestamp_ms=server_now,
                        execute_at_ms=execute_at,
                    )
                )
                await manager.broadcast(session_id, broadcast_msg.model_dump_json())
                client_pos = req.payload.position_ms
                server_pos = new_state.position_ms
                if abs(client_pos - server_pos) > 500:
                    logger.warning(
                        "Play: расхождение позиций client_pos=%d server_pos=%d (>500 мс)",
                        client_pos, server_pos, extra=log_extra,
                    )
                else:
                    logger.info(
                        "Play: client_pos=%d server_pos=%d execute_at=%.1f",
                        client_pos, server_pos, execute_at, extra=log_extra,
                    )
                continue

            if msg_type == "Pause":
                try:
                    req = PauseRequestMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "Pause: ожидается payload.position_ms (int, ≥0)",
                        )
                    )
                    continue

                server_now = server_now_ms()
                execute_at = server_now + EXECUTE_AT_DELAY_MS
                old_state = state_store.get_or_create(session_id)
                new_state = apply_pause(old_state, execute_at)

                if new_state is old_state:
                    logger.info("Pause (no-op, уже на паузе)", extra=log_extra)
                    continue

                state_store.set(session_id, new_state)
                broadcast_msg = PauseBroadcastMessage(
                    payload=PauseBroadcastPayload(
                        position_ms=new_state.position_ms,
                        server_timestamp_ms=server_now,
                        execute_at_ms=execute_at,
                    )
                )
                await manager.broadcast(session_id, broadcast_msg.model_dump_json())
                client_pos = req.payload.position_ms
                server_pos = new_state.position_ms
                if abs(client_pos - server_pos) > 500:
                    logger.warning(
                        "Pause: расхождение позиций client_pos=%d server_pos=%d (>500 мс)",
                        client_pos, server_pos, extra=log_extra,
                    )
                else:
                    logger.info(
                        "Pause: client_pos=%d server_pos=%d execute_at=%.1f",
                        client_pos, server_pos, execute_at, extra=log_extra,
                    )
                continue

            if msg_type == "Seek":
                try:
                    req = SeekRequestMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "Seek: ожидается payload.position_ms (int, ≥0)",
                        )
                    )
                    continue

                server_now = server_now_ms()
                execute_at = server_now + EXECUTE_AT_DELAY_MS
                old_state = state_store.get_or_create(session_id)
                new_state = apply_seek(old_state, execute_at, req.payload.position_ms)
                state_store.set(session_id, new_state)
                broadcast_msg = SeekBroadcastMessage(
                    payload=SeekBroadcastPayload(
                        position_ms=new_state.position_ms,
                        server_timestamp_ms=server_now,
                        execute_at_ms=execute_at,
                    )
                )
                await manager.broadcast(session_id, broadcast_msg.model_dump_json())
                logger.info(
                    "Seek: position_ms=%d execute_at=%.1f",
                    new_state.position_ms, execute_at, extra=log_extra,
                )
                continue

            if msg_type == "SetPlaybackRate":
                try:
                    req = SetPlaybackRateRequestMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            f"SetPlaybackRate: rate должен быть одним из {sorted({0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0})}",
                        )
                    )
                    continue

                server_now = server_now_ms()
                execute_at = server_now + EXECUTE_AT_DELAY_MS
                old_state = state_store.get_or_create(session_id)
                new_state = apply_set_rate(old_state, execute_at, req.payload.rate)
                state_store.set(session_id, new_state)
                broadcast_msg = SetPlaybackRateBroadcastMessage(
                    payload=SetPlaybackRateBroadcastPayload(
                        rate=new_state.playback_rate,
                        position_ms=new_state.position_ms,
                        server_timestamp_ms=server_now,
                        execute_at_ms=execute_at,
                    )
                )
                await manager.broadcast(session_id, broadcast_msg.model_dump_json())
                logger.info(
                    "SetPlaybackRate: rate=%.2f position_ms=%d execute_at=%.1f",
                    new_state.playback_rate, new_state.position_ms, execute_at,
                    extra=log_extra,
                )
                continue

            if msg_type == "SetVideoUrl":
                try:
                    req = SetVideoUrlMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "SetVideoUrl: ожидается payload.video_url (string, max 2048 символов)",
                        )
                    )
                    continue

                old_state = state_store.get_or_create(session_id)
                new_url = req.payload.video_url
                if new_url == old_state.video_url:
                    logger.info("SetVideoUrl (no-op, URL не изменился)", extra=log_extra)
                    continue

                now = server_now_ms()
                new_state = apply_set_video_url(old_state, new_url, now)
                state_store.set(session_id, new_state)
                broadcast_msg = VideoUrlChangedMessage(
                    payload=VideoUrlChangedPayload(video_url=new_url)
                )
                await manager.broadcast(session_id, broadcast_msg.model_dump_json())
                logger.info("SetVideoUrl: url='%s'", new_url, extra=log_extra)
                continue

            logger.warning(
                "Неизвестный тип сообщения: %s", msg_type, extra=log_extra
            )

    except WebSocketDisconnect:
        logger.info("Участник отключился: '%s'", nickname, extra=log_extra)
    finally:
        # Логируем Leave в БД до очистки менеджера
        await log_leave(session_id, user_id)
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
