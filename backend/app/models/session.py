from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.types import JSON
from sqlalchemy.orm import Mapped, mapped_column

from .base import Base


class Session(Base):
    __tablename__ = "sessions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime)
    video_url: Mapped[str] = mapped_column(String(2048), default="")
    # owner_id — логический FK к users; не объявляем ForeignKey чтобы избежать
    # циклической зависимости DDL (sessions ↔ users). SQLite всё равно не
    # проверяет FK по умолчанию.
    owner_id: Mapped[str | None] = mapped_column(String, nullable=True)
    current_state: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    session_id: Mapped[str] = mapped_column(
        String, ForeignKey("sessions.id"), nullable=False
    )
    nickname: Mapped[str] = mapped_column(String(64))
    role: Mapped[str] = mapped_column(String(32))  # owner / moderator / participant
    joined_at: Mapped[datetime] = mapped_column(DateTime)
    left_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
