"""REST-эндпоинты для анализа сессий и событий."""

from __future__ import annotations

import statistics
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import AsyncSessionLocal
from app.models.chat import ChatMessage as ChatMessageModel
from app.models.events import EventLog
from app.models.session import Session, User
from app.models.sync_measurement import SyncMeasurement
from app.schemas.messages import MeasureSyncMessage, MeasureSyncPayload
from app.sync.clock import server_now_ms
from app.ws.manager import manager

router = APIRouter(prefix="/api", tags=["analytics"])

_MEASURE_LEAD_MS = 500.0  # запас между триггером и моментом фиксации позиции


async def get_db() -> AsyncSession:
    async with AsyncSessionLocal() as db:
        yield db


# ---------- Схемы ответов ----------

class ParticipantCount(BaseModel):
    session_id: str
    created_at: str
    video_url: str
    participant_count: int


class EventRecord(BaseModel):
    id: int
    session_id: str
    user_id: str
    event_type: str
    server_timestamp_ms: float
    client_timestamp_ms: Optional[float]
    payload: Optional[dict]
    latency_ms: Optional[float]


class SessionStats(BaseModel):
    session_id: str
    event_counts: dict[str, int]
    time_sync_latency_ms: Optional[dict]  # avg / min / max для TimeSyncResponse
    play_timestamps_ms: Optional[dict]    # min / max / median для Play-событий


class ChatMessageRecord(BaseModel):
    id: int
    session_id: str
    user_id: str
    nickname: str
    text: str
    timestamp_ms: float
    deleted: bool


class SyncMeasurementGroup(BaseModel):
    measure_at_ms: float
    count: int           # сколько клиентов ответило
    min_pos_ms: int
    max_pos_ms: int
    desync_ms: int       # max - min
    positions_ms: list[int]


class SyncMeasurementsResponse(BaseModel):
    session_id: str
    groups: list[SyncMeasurementGroup]


class TriggerMeasureResponse(BaseModel):
    session_id: str
    measure_at_ms: float
    clients_notified: int


# ---------- Эндпоинты ----------

@router.get("/sessions", response_model=list[ParticipantCount])
async def list_sessions(db: AsyncSession = Depends(get_db)) -> list[ParticipantCount]:
    """Список всех сессий с количеством участников."""
    sessions_result = await db.execute(select(Session).order_by(Session.created_at.desc()))
    sessions = sessions_result.scalars().all()

    result = []
    for s in sessions:
        count_result = await db.execute(
            select(func.count()).select_from(User).where(User.session_id == s.id)
        )
        count = count_result.scalar_one()
        result.append(
            ParticipantCount(
                session_id=s.id,
                created_at=s.created_at.isoformat() if s.created_at else "",
                video_url=s.video_url or "",
                participant_count=count,
            )
        )
    return result


@router.get("/sessions/{session_id}/events", response_model=list[EventRecord])
async def get_events(
    session_id: str,
    event_type: Optional[str] = Query(default=None, description="Фильтр по типу события"),
    db: AsyncSession = Depends(get_db),
) -> list[EventRecord]:
    """Все события сессии, опционально отфильтрованные по event_type."""
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Сессия '{session_id}' не найдена")

    stmt = select(EventLog).where(EventLog.session_id == session_id)
    if event_type:
        stmt = stmt.where(EventLog.event_type == event_type)
    stmt = stmt.order_by(EventLog.server_timestamp_ms)

    result = await db.execute(stmt)
    rows = result.scalars().all()

    return [
        EventRecord(
            id=r.id,
            session_id=r.session_id,
            user_id=r.user_id,
            event_type=r.event_type,
            server_timestamp_ms=r.server_timestamp_ms,
            client_timestamp_ms=r.client_timestamp_ms,
            payload=r.payload,
            latency_ms=r.latency_ms,
        )
        for r in rows
    ]


@router.get("/sessions/{session_id}/stats", response_model=SessionStats)
async def get_stats(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> SessionStats:
    """Агрегаты по событиям сессии."""
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Сессия '{session_id}' не найдена")

    result = await db.execute(
        select(EventLog).where(EventLog.session_id == session_id)
    )
    events = result.scalars().all()

    # Количество событий по типу
    event_counts: dict[str, int] = {}
    for e in events:
        event_counts[e.event_type] = event_counts.get(e.event_type, 0) + 1

    # Агрегаты latency для TimeSyncResponse
    sync_latencies = [
        e.latency_ms for e in events
        if e.event_type == "TimeSyncResponse" and e.latency_ms is not None
    ]
    time_sync_latency_ms: Optional[dict] = None
    if sync_latencies:
        time_sync_latency_ms = {
            "avg_ms": round(sum(sync_latencies) / len(sync_latencies), 3),
            "min_ms": round(min(sync_latencies), 3),
            "max_ms": round(max(sync_latencies), 3),
            "count": len(sync_latencies),
        }

    # Агрегаты server_timestamp_ms для Play-событий
    play_ts = [
        e.server_timestamp_ms for e in events
        if e.event_type == "Play"
    ]
    play_timestamps_ms: Optional[dict] = None
    if play_ts:
        play_timestamps_ms = {
            "min_ms": round(min(play_ts), 3),
            "max_ms": round(max(play_ts), 3),
            "median_ms": round(statistics.median(play_ts), 3),
            "count": len(play_ts),
        }

    return SessionStats(
        session_id=session_id,
        event_counts=event_counts,
        time_sync_latency_ms=time_sync_latency_ms,
        play_timestamps_ms=play_timestamps_ms,
    )


@router.get("/sessions/{session_id}/chat", response_model=list[ChatMessageRecord])
async def get_chat(
    session_id: str,
    limit: int = Query(default=50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
) -> list[ChatMessageRecord]:
    """Последние N сообщений чата сессии (не удалённых)."""
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Сессия '{session_id}' не найдена")

    stmt = (
        select(ChatMessageModel, User)
        .join(User, ChatMessageModel.user_id == User.id, isouter=True)
        .where(ChatMessageModel.session_id == session_id)
        .where(ChatMessageModel.deleted == False)  # noqa: E712
        .order_by(ChatMessageModel.id.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    rows = list(reversed(result.all()))

    return [
        ChatMessageRecord(
            id=msg.id,
            session_id=msg.session_id,
            user_id=msg.user_id,
            nickname=user.nickname if user else msg.user_id,
            text=msg.text,
            timestamp_ms=msg.timestamp.timestamp() * 1000,
            deleted=msg.deleted,
        )
        for msg, user in rows
    ]


@router.post(
    "/sessions/{session_id}/measure",
    response_model=TriggerMeasureResponse,
    summary="Запустить измерение рассинхрона",
)
async def trigger_measure(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> TriggerMeasureResponse:
    """Рассылает MeasureSync всем клиентам в сессии.

    Клиенты фиксируют позицию плеера в момент measure_at_ms (server_now + 500мс)
    и отвечают SyncMeasurement. Результаты накапливаются в sync_measurements.
    """
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Сессия '{session_id}' не найдена")

    measure_at_ms = server_now_ms() + _MEASURE_LEAD_MS
    msg = MeasureSyncMessage(payload=MeasureSyncPayload(measure_at_ms=measure_at_ms))
    await manager.broadcast(session_id, msg.model_dump_json())

    clients = manager.get_participants(session_id)
    return TriggerMeasureResponse(
        session_id=session_id,
        measure_at_ms=measure_at_ms,
        clients_notified=len(clients),
    )


@router.get(
    "/sessions/{session_id}/sync-measurements",
    response_model=SyncMeasurementsResponse,
    summary="Получить результаты измерений рассинхрона",
)
async def get_sync_measurements(
    session_id: str,
    db: AsyncSession = Depends(get_db),
) -> SyncMeasurementsResponse:
    """Возвращает все измерения, сгруппированные по measure_at_ms.

    Для каждой группы вычисляет min, max, desync (max - min) и список позиций.
    """
    session = await db.get(Session, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail=f"Сессия '{session_id}' не найдена")

    result = await db.execute(
        select(SyncMeasurement)
        .where(SyncMeasurement.session_id == session_id)
        .order_by(SyncMeasurement.measure_at_ms, SyncMeasurement.received_at_ms)
    )
    rows = result.scalars().all()

    # Группируем по measure_at_ms (с округлением до 1 мс — защита от float-артефактов)
    groups: dict[float, list[int]] = {}
    for row in rows:
        key = round(row.measure_at_ms, 1)
        groups.setdefault(key, []).append(row.position_ms)

    result_groups = []
    for measure_at_ms, positions in sorted(groups.items()):
        min_pos = min(positions)
        max_pos = max(positions)
        result_groups.append(
            SyncMeasurementGroup(
                measure_at_ms=measure_at_ms,
                count=len(positions),
                min_pos_ms=min_pos,
                max_pos_ms=max_pos,
                desync_ms=max_pos - min_pos,
                positions_ms=sorted(positions),
            )
        )

    return SyncMeasurementsResponse(session_id=session_id, groups=result_groups)
