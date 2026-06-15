from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field

from fastapi import WebSocket

from app.schemas.messages import ParticipantInfo
from app.services.session_state import state_store
from app.sync.clock import server_now_ms

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
    # Момент назначения текущей роли (server_now_ms).
    # Для creator/participant — время входа; для admin — время GrantAdmin.
    # Используется в transfer_creator для выбора «старейшего».
    role_assigned_at: float = field(default=0.0)


class ConnectionManager:
    def __init__(self) -> None:
        # session_id → { user_id → ConnectedParticipant }
        self._sessions: dict[str, dict[str, ConnectedParticipant]] = {}

    # ------------------------------------------------------------------
    # Подключение / отключение
    # ------------------------------------------------------------------

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

        role = "creator" if not session else "participant"
        now = server_now_ms()
        session[user_id] = ConnectedParticipant(
            user_id=user_id,
            nickname=nickname,
            role=role,
            websocket=websocket,
            role_assigned_at=now,
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

    # ------------------------------------------------------------------
    # Чтение состояния
    # ------------------------------------------------------------------

    def get_participant(self, session_id: str, user_id: str) -> ConnectedParticipant | None:
        session = self._sessions.get(session_id)
        if session is None:
            return None
        return session.get(user_id)

    def get_role(self, session_id: str, user_id: str) -> str | None:
        p = self.get_participant(session_id, user_id)
        return p.role if p is not None else None

    def get_nickname(self, session_id: str, user_id: str) -> str | None:
        p = self.get_participant(session_id, user_id)
        return p.nickname if p is not None else None

    def get_participants(self, session_id: str) -> list[ParticipantInfo]:
        session = self._sessions.get(session_id, {})
        return [
            ParticipantInfo(id=p.user_id, nickname=p.nickname, role=p.role)
            for p in session.values()
        ]

    def session_has_members(self, session_id: str) -> bool:
        return bool(self._sessions.get(session_id))

    # ------------------------------------------------------------------
    # Изменение ролей
    # ------------------------------------------------------------------

    def set_role(self, session_id: str, user_id: str, role: str, assigned_at: float) -> bool:
        """Меняет роль участника. Возвращает False если участник не найден."""
        p = self.get_participant(session_id, user_id)
        if p is None:
            return False
        p.role = role
        p.role_assigned_at = assigned_at
        return True

    def grant_admin(
        self, session_id: str, requester_id: str, target_id: str
    ) -> tuple[str, str] | None:
        """
        Назначает target_id роль admin.
        Возвращает None при успехе или (код_ошибки, сообщение) при неудаче.
        """
        if self.get_role(session_id, requester_id) != "creator":
            return ("FORBIDDEN", "Недостаточно прав: только creator может назначать admin")

        target = self.get_participant(session_id, target_id)
        if target is None:
            return ("USER_NOT_FOUND", f"Участник {target_id} не найден в сессии")

        if target.role == "creator":
            return ("FORBIDDEN", "Нельзя назначить admin пользователю с ролью creator")

        self.set_role(session_id, target_id, "admin", server_now_ms())
        logger.info(
            "GrantAdmin: %s → admin (запрос от %s)",
            target_id, requester_id,
            extra={"session_id": session_id, "user_id": requester_id},
        )
        return None

    def revoke_admin(
        self, session_id: str, requester_id: str, target_id: str
    ) -> tuple[str, str] | None:
        """
        Снимает роль admin с target_id.
        Возвращает None при успехе или (код_ошибки, сообщение) при неудаче.
        """
        if self.get_role(session_id, requester_id) != "creator":
            return ("FORBIDDEN", "Недостаточно прав: только creator может снимать admin")

        target = self.get_participant(session_id, target_id)
        if target is None:
            return ("USER_NOT_FOUND", f"Участник {target_id} не найден в сессии")

        if target.role != "admin":
            return ("FORBIDDEN", "Нельзя снять роль admin у участника без этой роли")

        self.set_role(session_id, target_id, "participant", server_now_ms())
        logger.info(
            "RevokeAdmin: %s → participant (запрос от %s)",
            target_id, requester_id,
            extra={"session_id": session_id, "user_id": requester_id},
        )
        return None

    def transfer_creator(self, session_id: str) -> str | None:
        """
        Передаёт роль creator старейшему admin (по role_assigned_at),
        или, если adminов нет, старейшему participant.
        Вызывается после того, как прежний creator уже удалён из сессии.
        Возвращает user_id нового creator или None если сессия пуста.
        """
        session = self._sessions.get(session_id)
        if not session:
            return None

        admins = [p for p in session.values() if p.role == "admin"]
        if admins:
            new_creator = min(admins, key=lambda p: p.role_assigned_at)
        else:
            participants = list(session.values())
            if not participants:
                return None
            new_creator = min(participants, key=lambda p: p.role_assigned_at)

        new_creator.role = "creator"
        new_creator.role_assigned_at = server_now_ms()
        logger.info(
            "Роль creator передана: %s ('%s')",
            new_creator.user_id, new_creator.nickname,
            extra={"session_id": session_id, "user_id": new_creator.user_id},
        )
        return new_creator.user_id

    # ------------------------------------------------------------------
    # Рассылка
    # ------------------------------------------------------------------

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

    async def close_all(self, session_id: str) -> None:
        """
        Закрывает все WS-соединения в сессии и удаляет сессию из памяти.
        Вызывается при CloseRoom. Удаление session до закрытия сокетов
        гарантирует, что finally-блоки других хендлеров не пошлют ParticipantLeft.
        """
        session = self._sessions.pop(session_id, None)
        if not session:
            return
        state_store.drop(session_id)
        await asyncio.gather(
            *[p.websocket.close(1000) for p in session.values()],
            return_exceptions=True,
        )
        logger.info(
            "Сессия закрыта командой CloseRoom (%d участников)",
            len(session),
            extra={"session_id": session_id, "user_id": "-"},
        )


# Синглтон — один менеджер на весь процесс uvicorn
manager = ConnectionManager()
