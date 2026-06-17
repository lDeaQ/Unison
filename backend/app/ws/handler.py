from __future__ import annotations

import asyncio
import json
import logging
from uuid import uuid4

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from app.schemas.messages import (
    ChatMessageBroadcastMessage,
    ChatMessageBroadcastPayload,
    ChatMessageRequestMessage,
    CloseRoomMessage,
    ErrorMessage,
    ErrorPayload,
    GrantAdminMessage,
    HelloMessage,
    MeasureSyncMessage,
    ParticipantJoinedMessage,
    ParticipantJoinedPayload,
    ParticipantLeftMessage,
    ParticipantLeftPayload,
    PauseBroadcastMessage,
    PauseBroadcastPayload,
    PauseRequestMessage,
    PersonalPlayMessage,
    PersonalPlayPayload,
    PlayBroadcastMessage,
    PlayBroadcastPayload,
    PlayRequestMessage,
    RevokeAdminMessage,
    RoleChangedMessage,
    RoleChangedPayload,
    RoomClosedMessage,
    RoomClosedPayload,
    SeekBroadcastMessage,
    SeekBroadcastPayload,
    SeekRequestMessage,
    SetPlaybackRateBroadcastMessage,
    SetPlaybackRateBroadcastPayload,
    SetPlaybackRateRequestMessage,
    SetVideoUrlMessage,
    SyncMeasurementMessage,
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
    save_chat_message,
    save_sync_measurement,
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
# Дополнительная задержка на буферизацию при входе в играющую сессию.
# RuTube после seek начинает буферизовать — нужно 2–3 с до старта воспроизведения.
_PERSONAL_PLAY_BUFFER_MS = 2000


def _make_error(code: str, message: str) -> str:
    return ErrorMessage(payload=ErrorPayload(code=code, message=message)).model_dump_json()


def _can_control(role: str) -> bool:
    """Creator и admin могут управлять воспроизведением."""
    return role in ("creator", "admin")


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
    logger.info("Hello от '%s' (роль: %s)", nickname, role, extra=log_extra)

    try:
        # 4. Welcome только этому клиенту — с актуальным состоянием сессии
        session_state = state_store.get_or_create(session_id)
        logger.info(
            "Новый клиент %s, is_playing=%s, position_ms=%s",
            user_id, session_state.is_playing, session_state.position_ms,
            extra=log_extra,
        )
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

        # 6. PersonalPlay — только если сессия воспроизводится в момент входа.
        if session_state.is_playing:
            personal_now = server_now_ms()
            personal_execute_at = personal_now + EXECUTE_AT_DELAY_MS + _PERSONAL_PLAY_BUFFER_MS
            target_position_ms = compute_current_position_ms(session_state, personal_execute_at)
            personal_play = PersonalPlayMessage(
                payload=PersonalPlayPayload(
                    position_ms=target_position_ms,
                    server_timestamp_ms=personal_now,
                    execute_at_ms=personal_execute_at,
                )
            )
            logger.info(
                "Отправка PersonalPlay клиенту %s, позиция=%.0f мс, execute_at=%.0f",
                user_id, target_position_ms, personal_execute_at,
                extra=log_extra,
            )
            await websocket.send_text(personal_play.model_dump_json())
            logger.info(
                "PersonalPlay отправлен: target_pos=%d execute_at=%.1f (+%d ms буфер)",
                target_position_ms, personal_execute_at, _PERSONAL_PLAY_BUFFER_MS,
                extra=log_extra,
            )

        # 7. Основной цикл — получаем и обрабатываем входящие сообщения
        while True:
            raw = await websocket.receive_text()
            # t1_candidate фиксируется как можно раньше — до JSON-разбора и валидации.
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
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "TimeSyncRequest: ожидается payload.client_send_ms (float)",
                        )
                    )
                    continue

                t2 = server_now_ms()
                response = TimeSyncResponseMessage(
                    payload=TimeSyncResponsePayload(
                        client_send_ms=req.payload.client_send_ms,
                        server_receive_ms=t1_candidate,
                        server_send_ms=t2,
                    )
                )
                await websocket.send_text(response.model_dump_json())
                logger.debug("TimeSync обработан", extra=log_extra)
                await log_time_sync(session_id, user_id, t1_candidate, t2)
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

                # Проверяем роль в момент команды — не при подключении,
                # т.к. роль могла смениться (promote/demote) за время сессии.
                if not _can_control(manager.get_role(session_id, user_id) or ""):
                    await websocket.send_text(
                        _make_error("FORBIDDEN", "Недостаточно прав: управление видео доступно creator и admin")
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
                await log_command(
                    session_id, user_id, "Play", server_now,
                    payload={"position_ms": server_pos, "execute_at_ms": execute_at},
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

                if not _can_control(manager.get_role(session_id, user_id) or ""):
                    await websocket.send_text(
                        _make_error("FORBIDDEN", "Недостаточно прав: управление видео доступно creator и admin")
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
                await log_command(
                    session_id, user_id, "Pause", server_now,
                    payload={"position_ms": server_pos, "execute_at_ms": execute_at},
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

                if not _can_control(manager.get_role(session_id, user_id) or ""):
                    await websocket.send_text(
                        _make_error("FORBIDDEN", "Недостаточно прав: управление видео доступно creator и admin")
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
                await log_command(
                    session_id, user_id, "Seek", server_now,
                    payload={"position_ms": new_state.position_ms, "execute_at_ms": execute_at},
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

                if not _can_control(manager.get_role(session_id, user_id) or ""):
                    await websocket.send_text(
                        _make_error("FORBIDDEN", "Недостаточно прав: управление видео доступно creator и admin")
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
                await log_command(
                    session_id, user_id, "SetPlaybackRate", server_now,
                    payload={
                        "rate": new_state.playback_rate,
                        "position_ms": new_state.position_ms,
                        "execute_at_ms": execute_at,
                    },
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

                if not _can_control(manager.get_role(session_id, user_id) or ""):
                    await websocket.send_text(
                        _make_error("FORBIDDEN", "Недостаточно прав: управление видео доступно creator и admin")
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

            if msg_type == "ChatMessage":
                try:
                    req = ChatMessageRequestMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "ChatMessage: ожидается payload.text (строка 1–500 символов)",
                        )
                    )
                    continue

                server_now = server_now_ms()
                message_id = await save_chat_message(
                    session_id, user_id, req.payload.text, server_now
                )
                await log_command(
                    session_id, user_id, "Chat", server_now,
                    payload={"text": req.payload.text[:50]},
                )
                broadcast_msg = ChatMessageBroadcastMessage(
                    payload=ChatMessageBroadcastPayload(
                        message_id=message_id,
                        user_id=user_id,
                        nickname=nickname,
                        text=req.payload.text,
                        timestamp_ms=server_now,
                    )
                )
                await manager.broadcast(session_id, broadcast_msg.model_dump_json())
                logger.info(
                    "ChatMessage: user='%s' message_id=%d len=%d",
                    nickname, message_id, len(req.payload.text),
                    extra=log_extra,
                )
                continue

            if msg_type == "SyncMeasurement":
                try:
                    req = SyncMeasurementMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "SyncMeasurement: ожидается payload.position_ms (int≥0) и measure_at_ms (float)",
                        )
                    )
                    continue

                received_at = server_now_ms()
                await save_sync_measurement(
                    session_id, user_id,
                    req.payload.measure_at_ms,
                    req.payload.position_ms,
                    received_at,
                )
                logger.debug(
                    "SyncMeasurement: position_ms=%d measure_at_ms=%.1f",
                    req.payload.position_ms, req.payload.measure_at_ms, extra=log_extra,
                )
                continue

            if msg_type == "SeekReady":
                # PersonalPlay уже отправлен при входе — здесь только лог.
                server_now = server_now_ms()
                await log_command(
                    session_id, user_id, "SeekReady", server_now, payload={}
                )
                logger.info("SeekReady получен (клиент готов к PersonalPlay)", extra=log_extra)
                continue

            if msg_type == "GrantAdmin":
                try:
                    req = GrantAdminMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "GrantAdmin: ожидается payload.target_user_id (string)",
                        )
                    )
                    continue

                error = manager.grant_admin(session_id, user_id, req.payload.target_user_id)
                if error is not None:
                    code, msg = error
                    await websocket.send_text(_make_error(code, msg))
                    continue

                role_msg = RoleChangedMessage(
                    payload=RoleChangedPayload(
                        user_id=req.payload.target_user_id,
                        new_role="admin",
                        reason="granted",
                    )
                )
                await manager.broadcast(session_id, role_msg.model_dump_json())
                logger.info(
                    "GrantAdmin: %s → admin", req.payload.target_user_id, extra=log_extra
                )
                continue

            if msg_type == "RevokeAdmin":
                try:
                    req = RevokeAdminMessage.model_validate(parsed)
                except ValidationError:
                    await websocket.send_text(
                        _make_error(
                            "INVALID_MESSAGE",
                            "RevokeAdmin: ожидается payload.target_user_id (string)",
                        )
                    )
                    continue

                error = manager.revoke_admin(session_id, user_id, req.payload.target_user_id)
                if error is not None:
                    code, msg = error
                    await websocket.send_text(_make_error(code, msg))
                    continue

                role_msg = RoleChangedMessage(
                    payload=RoleChangedPayload(
                        user_id=req.payload.target_user_id,
                        new_role="participant",
                        reason="revoked",
                    )
                )
                await manager.broadcast(session_id, role_msg.model_dump_json())
                logger.info(
                    "RevokeAdmin: %s → participant", req.payload.target_user_id, extra=log_extra
                )
                continue

            if msg_type == "CloseRoom":
                # CloseRoom не валидируется по схеме — payload пустой.
                current_role = manager.get_role(session_id, user_id)
                if current_role != "creator":
                    await websocket.send_text(
                        _make_error("FORBIDDEN", "Только creator может закрыть комнату")
                    )
                    continue

                # Рассылаем RoomClosed всем до разрыва соединений
                room_closed_msg = RoomClosedMessage(payload=RoomClosedPayload())
                await manager.broadcast(session_id, room_closed_msg.model_dump_json())
                logger.info("CloseRoom: рассылка RoomClosed и закрытие сессии", extra=log_extra)
                # close_all удаляет сессию из памяти и закрывает все WS
                await manager.close_all(session_id)
                # Наш WS тоже закрыт — следующий receive_text() кинет WebSocketDisconnect
                continue

            logger.warning(
                "Неизвестный тип сообщения: %s", msg_type, extra=log_extra
            )

    except WebSocketDisconnect:
        logger.info("Участник отключился: '%s'", nickname, extra=log_extra)
    finally:
        await log_leave(session_id, user_id)

        # Читаем роль ДО disconnect — после неё участник уже удалён из сессии
        departing = manager.get_participant(session_id, user_id)
        departing_role = departing.role if departing is not None else None

        participant = manager.disconnect(session_id, user_id)

        if participant and manager.session_has_members(session_id):
            # Если ушёл creator — автоматически передаём роль
            if departing_role == "creator":
                new_creator_id = manager.transfer_creator(session_id)
                if new_creator_id:
                    role_msg = RoleChangedMessage(
                        payload=RoleChangedPayload(
                            user_id=new_creator_id,
                            new_role="creator",
                            reason="creator_transferred",
                        )
                    )
                    try:
                        await manager.broadcast(session_id, role_msg.model_dump_json())
                        logger.info(
                            "Роль creator передана участнику %s", new_creator_id,
                            extra=log_extra,
                        )
                    except Exception:
                        logger.exception(
                            "Ошибка при рассылке RoleChanged (creator_transferred)",
                            extra=log_extra,
                        )

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
