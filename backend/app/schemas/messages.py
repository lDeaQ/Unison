from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


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
    server_time_ms: float  # серверное время отправки; используется клиентом для anchor-коррекции


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


# ---------------------------------------------------------------------------
# Команды воспроизведения — входящие (client → server)
# ---------------------------------------------------------------------------

class PlayRequestPayload(BaseModel):
    # Подсказка клиента о его текущей позиции — используется только для диагностики
    # (сравнение с серверным state в логах). В логике broadcast не учитывается.
    position_ms: int = Field(ge=0)


class PlayRequestMessage(BaseModel):
    type: Literal["Play"]
    payload: PlayRequestPayload


class PauseRequestPayload(BaseModel):
    position_ms: int = Field(ge=0)


class PauseRequestMessage(BaseModel):
    type: Literal["Pause"]
    payload: PauseRequestPayload


class SeekRequestPayload(BaseModel):
    position_ms: int = Field(ge=0)


class SeekRequestMessage(BaseModel):
    type: Literal["Seek"]
    payload: SeekRequestPayload


_ALLOWED_RATES: frozenset[float] = frozenset(
    {0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0}
)


class SetPlaybackRateRequestPayload(BaseModel):
    rate: float

    @field_validator("rate")
    @classmethod
    def _rate_must_be_allowed(cls, v: float) -> float:
        if v not in _ALLOWED_RATES:
            raise ValueError(
                f"rate {v} не в списке разрешённых: {sorted(_ALLOWED_RATES)}"
            )
        return v


class SetPlaybackRateRequestMessage(BaseModel):
    type: Literal["SetPlaybackRate"]
    payload: SetPlaybackRateRequestPayload


# ---------------------------------------------------------------------------
# Команды воспроизведения — исходящие бродкасты (server → all clients)
# ---------------------------------------------------------------------------
# Суффикс _ms у временны́х полей для единообразия с TimeSyncRequest/Response.
# Отдельные классы для каждой команды — для строгого сужения по полю type
# на фронте (TypeScript discriminated union).

class PlayBroadcastPayload(BaseModel):
    position_ms: int        # позиция, с которой начнётся воспроизведение
    server_timestamp_ms: float
    execute_at_ms: float    # серверное Unix ms, когда команда должна примениться


class PlayBroadcastMessage(BaseModel):
    type: Literal["Play"] = "Play"
    payload: PlayBroadcastPayload


class PauseBroadcastPayload(BaseModel):
    position_ms: int        # позиция, зафиксированная на момент execute_at
    server_timestamp_ms: float
    execute_at_ms: float


class PauseBroadcastMessage(BaseModel):
    type: Literal["Pause"] = "Pause"
    payload: PauseBroadcastPayload


class SeekBroadcastPayload(BaseModel):
    position_ms: int        # новая позиция после seek
    server_timestamp_ms: float
    execute_at_ms: float


class SeekBroadcastMessage(BaseModel):
    type: Literal["Seek"] = "Seek"
    payload: SeekBroadcastPayload


class SetPlaybackRateBroadcastPayload(BaseModel):
    rate: float
    # Позиция на момент execute_at по СТАРОМУ rate — обеспечивает непрерывность.
    # Обоснование в docs/plan_commands.md §5.6.
    position_ms: int
    server_timestamp_ms: float
    execute_at_ms: float


class SetPlaybackRateBroadcastMessage(BaseModel):
    type: Literal["SetPlaybackRate"] = "SetPlaybackRate"
    payload: SetPlaybackRateBroadcastPayload


# ---------------------------------------------------------------------------
# Смена видео
# ---------------------------------------------------------------------------

class SetVideoUrlPayload(BaseModel):
    video_url: str = Field(max_length=2048)


class SetVideoUrlMessage(BaseModel):
    type: Literal["SetVideoUrl"]
    payload: SetVideoUrlPayload


class VideoUrlChangedPayload(BaseModel):
    video_url: str


class VideoUrlChangedMessage(BaseModel):
    type: Literal["VideoUrlChanged"] = "VideoUrlChanged"
    payload: VideoUrlChangedPayload
