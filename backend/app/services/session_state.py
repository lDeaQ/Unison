"""Серверно-авторитетная модель состояния воспроизведения.

Состояние сессии полностью определяется тройкой
(position_ms, anchor_server_ms, is_playing) + playback_rate. В любой момент
серверного времени `now_ms` текущая позиция вычисляется детерминированно
по формуле:

    position_at(now) = position_ms + (now - anchor_server_ms) * rate   если is_playing
    position_at(now) = position_ms                                       иначе

Это позволяет:
- между командами не рассылать никаких обновлений (клиенты сами знают, куда
  «уехала» позиция);
- использовать одинаковую формулу на сервере и клиенте, единственное расхождение
  между сторонами — точность ClockSync (≈ 1 мс на localhost).

Чистые функции apply_* возвращают НОВОЕ состояние, не мутируя старое — это
упрощает тестирование и логирование (можно сравнить old/new).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SessionState:
    """Состояние воспроизведения в сессии (иммутабельное)."""

    is_playing: bool = False
    position_ms: int = 0
    anchor_server_ms: float = 0.0
    playback_rate: float = 1.0
    video_url: str = ""


def compute_current_position_ms(state: SessionState, now_ms: float) -> int:
    """Текущая позиция воспроизведения на момент now_ms (серверное время).

    На паузе позиция не меняется со временем — возвращаем как есть.
    При воспроизведении вычисляем `position_ms + прошедшее_время * rate`.
    Округление вниз через int() — единый подход с фронтом (Math.floor),
    обоснование в docs/plan_commands.md §5.7.
    """
    if not state.is_playing:
        return state.position_ms
    elapsed_ms = (now_ms - state.anchor_server_ms) * state.playback_rate
    return state.position_ms + int(elapsed_ms)


def apply_play(state: SessionState, execute_at_ms: float) -> SessionState:
    """Запуск воспроизведения.

    Идемпотентность: если уже играем — возвращаем тот же объект (по identity),
    обработчик это детектит через `new_state is old_state` и не делает broadcast.
    Позиция не меняется; anchor — момент реального старта (execute_at).
    """
    if state.is_playing:
        return state
    return SessionState(
        is_playing=True,
        position_ms=state.position_ms,
        anchor_server_ms=execute_at_ms,
        playback_rate=state.playback_rate,
        video_url=state.video_url,
    )


def apply_pause(state: SessionState, execute_at_ms: float) -> SessionState:
    """Постановка на паузу.

    Идемпотентность: если уже на паузе — возвращаем тот же объект.
    Иначе фиксируем позицию ИМЕННО на момент execute_at (а не на now_ms
    обработчика), чтобы все клиенты пришли к одинаковому состоянию.
    """
    if not state.is_playing:
        return state
    position_at_exec = compute_current_position_ms(state, execute_at_ms)
    return SessionState(
        is_playing=False,
        position_ms=position_at_exec,
        anchor_server_ms=execute_at_ms,
        playback_rate=state.playback_rate,
        video_url=state.video_url,
    )


def apply_seek(
    state: SessionState, execute_at_ms: float, new_position_ms: int
) -> SessionState:
    """Перемотка на new_position_ms.

    Состояние is_playing СОХРАНЯЕТСЯ. Это поведение реальных плееров: seek во
    время игры не ставит на паузу; seek на паузе не начинает играть.
    Always-apply — даже если new_position_ms == текущей: это явный жест
    пользователя (см. plan_commands.md §5.3).
    """
    return SessionState(
        is_playing=state.is_playing,
        position_ms=new_position_ms,
        anchor_server_ms=execute_at_ms,
        playback_rate=state.playback_rate,
        video_url=state.video_url,
    )


def apply_set_rate(
    state: SessionState, execute_at_ms: float, new_rate: float
) -> SessionState:
    """Смена скорости воспроизведения.

    Непрерывность позиции: новый anchor = execute_at, новая позиция —
    результат compute_current_position_ms по СТАРОМУ rate. После этой команды
    при том же execute_at позиция совпадает у старой и новой моделей; далее
    время летит с новой скоростью.
    """
    position_at_exec = compute_current_position_ms(state, execute_at_ms)
    return SessionState(
        is_playing=state.is_playing,
        position_ms=position_at_exec,
        anchor_server_ms=execute_at_ms,
        playback_rate=new_rate,
        video_url=state.video_url,
    )


def apply_set_video_url(
    state: SessionState, new_url: str, now_ms: float
) -> SessionState:
    """Смена видео. Сбрасывает воспроизведение в начало.

    Сброс is_playing=False и position_ms=0: новое видео всегда начинается
    с начала. Сохранить позицию невозможно — длина нового видео неизвестна,
    позиция может оказаться за пределами duration.
    Playback_rate сохраняется — это настройка пользователя, не привязанная к видео.
    """
    return SessionState(
        is_playing=False,
        position_ms=0,
        anchor_server_ms=now_ms,
        playback_rate=state.playback_rate,
        video_url=new_url,
    )


class SessionStateStore:
    """Хранит SessionState per session_id. Создаёт при первом обращении.

    Без asyncio.Lock: uvicorn — single-threaded event loop, между awaitами
    последовательность get → mutate → set атомарна.
    """

    def __init__(self) -> None:
        self._states: dict[str, SessionState] = {}

    def get_or_create(self, session_id: str) -> SessionState:
        st = self._states.get(session_id)
        if st is None:
            st = SessionState()
            self._states[session_id] = st
        return st

    def set(self, session_id: str, new_state: SessionState) -> None:
        self._states[session_id] = new_state

    def drop(self, session_id: str) -> None:
        self._states.pop(session_id, None)

    def has(self, session_id: str) -> bool:
        return session_id in self._states


state_store = SessionStateStore()
