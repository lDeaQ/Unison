from pathlib import Path

from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker

from app.models.base import Base
# Импорт моделей нужен, чтобы их метаданные попали в Base.metadata до create_all
from app.models import Session, User, EventLog, ChatMessage  # noqa: F401

DB_PATH = Path(__file__).parent.parent / "data" / "app.db"
DATABASE_URL = f"sqlite+aiosqlite:///{DB_PATH}"

engine: AsyncEngine = create_async_engine(DATABASE_URL, echo=False)

AsyncSessionLocal: sessionmaker = sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
)


async def init_db() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
