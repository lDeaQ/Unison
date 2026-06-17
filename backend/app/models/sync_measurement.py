from __future__ import annotations

from sqlalchemy import Float, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class SyncMeasurement(Base):
    __tablename__ = "sync_measurements"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id"), nullable=False
    )
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    # Серверное время, в которое клиент должен был зафиксировать позицию
    measure_at_ms: Mapped[float] = mapped_column(Float, nullable=False)
    # Позиция плеера, зафиксированная клиентом в момент measure_at_ms
    position_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    # Серверное время получения ответа от клиента
    received_at_ms: Mapped[float] = mapped_column(Float, nullable=False)

    __table_args__ = (
        Index("ix_sync_measurements_session_measure", "session_id", "measure_at_ms"),
    )
