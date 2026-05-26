from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class ParticipantInfo(BaseModel):
    id: str
    nickname: str
    role: str  # "owner" | "participant"


# --- Входящие: клиент → сервер ---

class HelloPayload(BaseModel):
    session_id: str
    nickname: str


class HelloMessage(BaseModel):
    type: Literal["Hello"]
    payload: HelloPayload


class TimeSyncRequestPayload(BaseModel):
    # Клиентское время t0 в момент отправки. Float, миллисекунды с дробной частью —
    # int отбрасывал бы субмиллисекундную точность, которую performance.now() даёт.
    client_send_ms: float


class TimeSyncRequestMessage(BaseModel):
    type: Literal["TimeSyncRequest"]
    payload: TimeSyncRequestPayload


# --- Исходящие: сервер → клиент ---

class WelcomePayload(BaseModel):
    session_id: str
    your_user_id: str
    video_url: str
    is_playing: bool
    position_ms: int
    playback_rate: float
    participants: list[ParticipantInfo]


class WelcomeMessage(BaseModel):
    type: Literal["Welcome"] = "Welcome"
    payload: WelcomePayload


class ParticipantJoinedPayload(BaseModel):
    id: str
    nickname: str
    role: str


class ParticipantJoinedMessage(BaseModel):
    type: Literal["ParticipantJoined"] = "ParticipantJoined"
    payload: ParticipantJoinedPayload


class ParticipantLeftPayload(BaseModel):
    id: str
    nickname: str


class ParticipantLeftMessage(BaseModel):
    type: Literal["ParticipantLeft"] = "ParticipantLeft"
    payload: ParticipantLeftPayload


class ErrorPayload(BaseModel):
    code: str     # "HELLO_REQUIRED" | "INVALID_MESSAGE" | "NICKNAME_TAKEN"
    message: str  # человекочитаемое описание


class ErrorMessage(BaseModel):
    type: Literal["Error"] = "Error"
    payload: ErrorPayload


class TimeSyncResponsePayload(BaseModel):
    # Эхо t0 от клиента — клиент по нему сопоставляет запрос с ответом
    # без необходимости вести очередь pending-запросов.
    client_send_ms: float
    # t1 — серверное время в момент приёма запроса (фиксируется как можно раньше).
    server_receive_ms: float
    # t2 — серверное время прямо перед отправкой ответа.
    server_send_ms: float


class TimeSyncResponseMessage(BaseModel):
    type: Literal["TimeSyncResponse"] = "TimeSyncResponse"
    payload: TimeSyncResponsePayload
