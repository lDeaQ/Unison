from __future__ import annotations

import logging
from dataclasses import dataclass

from fastapi import WebSocket

from app.schemas.messages import ParticipantInfo
from app.services.session_state import state_store

logger = logging.getLogger(__name__)


class NicknameTakenError(Exception):
    def __init__(self, nickname: str) -> None:
        self.nickname = nickname
        super().__init__(f"Ник '{nickname}' уже занят в этой сессии")


@dataclass
class ConnectedParticipant:
    user_id: str
    nickname: str
    role: str
    websocket: WebSocket


class ConnectionManager:
    def __init__(self) -> None:
        # session_id → { user_id → ConnectedParticipant }
        self._sessions: dict[str, dict[str, ConnectedParticipant]] = {}

    def connect(
        self,
        session_id: str,
        user_id: str,
        nickname: str,
        websocket: WebSocket,
    ) -> str:
        """Добавляет участника в сессию. Возвращает назначенную роль."""
        session = self._sessions.setdefault(session_id, {})

        if any(p.nickname == nickname for p in session.values()):
            raise NicknameTakenError(nickname)

        role = "owner" if not session else "participant"
        session[user_id] = ConnectedParticipant(
            user_id=user_id,
            nickname=nickname,
            role=role,
            websocket=websocket,
        )
        logger.info(
            "Участник добавлен: '%s' (%s)",
            nickname,
            role,
            extra={"session_id": session_id, "user_id": user_id},
        )
        return role

    def disconnect(self, session_id: str, user_id: str) -> ConnectedParticipant | None:
        """Удаляет участника. Возвращает его данные или None если не найден."""
        session = self._sessions.get(session_id)
        if session is None:
            return None
        participant = session.pop(user_id, None)
        if not session:
            del self._sessions[session_id]
            state_store.drop(session_id)
            logger.info(
                "Сессия закрыта (все участники ушли)",
                extra={"session_id": session_id, "user_id": user_id},
            )
        return participant

    def get_participants(self, session_id: str) -> list[ParticipantInfo]:
        session = self._sessions.get(session_id, {})
        return [
            ParticipantInfo(id=p.user_id, nickname=p.nickname, role=p.role)
            for p in session.values()
        ]

    def session_has_members(self, session_id: str) -> bool:
        return bool(self._sessions.get(session_id))

    async def broadcast(
        self,
        session_id: str,
        message: str,
        exclude_user_id: str | None = None,
    ) -> None:
        """Рассылает JSON-строку всем участникам сессии, кроме exclude_user_id."""
        session = self._sessions.get(session_id)
        if not session:
            return

        failed: list[str] = []
        # Итерируемся по копии — disconnect во время итерации безопасен
        for user_id, participant in list(session.items()):
            if user_id == exclude_user_id:
                continue
            try:
                await participant.websocket.send_text(message)
            except Exception:
                logger.warning(
                    "Ошибка отправки участнику '%s', будет отключён",
                    participant.nickname,
                    extra={"session_id": session_id, "user_id": user_id},
                )
                failed.append(user_id)

        for user_id in failed:
            self.disconnect(session_id, user_id)


# Синглтон — один менеджер на весь процесс uvicorn
manager = ConnectionManager()
