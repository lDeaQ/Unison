from __future__ import annotations

from sqlalchemy import Float, ForeignKey, Integer, String
from sqlalchemy.types import JSON
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class EventLog(Base):
    __tablename__ = "events_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    # Play / Pause / Seek / SetPlaybackRate / Join / Leave / TimeSyncResponse
    event_type: Mapped[str] = mapped_column(String(32), nullable=False)
    server_timestamp_ms: Mapped[float] = mapped_column(Float, nullable=False)
    client_timestamp_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
    payload: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    latency_ms: Mapped[float | None] = mapped_column(Float, nullable=True)
