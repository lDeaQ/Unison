"""Юнит-тесты для чистой модели состояния воспроизведения.

Кейсы соответствуют docs/plan_commands.md §4.1 (1–11). Тесты проверяют:
- детерминизм формулы compute_current_position_ms;
- идемпотентность apply_play / apply_pause при совпадении состояния;
- корректную фиксацию позиции на момент execute_at;
- непрерывность позиции при смене rate;
- сохранение is_playing в apply_seek;
- композицию серии команд.
"""

from __future__ import annotations

import pytest

from app.services.session_state import (
    SessionState,
    SessionStateStore,
    apply_pause,
    apply_play,
    apply_seek,
    apply_set_rate,
    compute_current_position_ms,
)


# --- 1. compute_current_position_ms ---


def test_compute_position_paused_returns_position_regardless_of_now() -> None:
    """На паузе позиция не зависит от now_ms — возвращается position_ms как есть."""
    state = SessionState(
        is_playing=False,
        position_ms=5000,
        anchor_server_ms=1_000_000.0,
        playback_rate=1.0,
    )
    assert compute_current_position_ms(state, now_ms=1_000_000.0) == 5000
    assert compute_current_position_ms(state, now_ms=9_999_999.0) == 5000
    assert compute_current_position_ms(state, now_ms=0.0) == 5000


def test_compute_position_playing_rate_one_advances_linearly() -> None:
    """Игра с rate=1.0: за 2000 мс серверного времени позиция растёт на 2000 мс."""
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    assert compute_current_position_ms(state, now_ms=12_000.0) == 3000


def test_compute_position_playing_with_rate_two_advances_twice_as_fast() -> None:
    """Игра с rate=2.0: за те же 2000 мс позиция растёт на 4000 мс."""
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=2.0,
    )
    assert compute_current_position_ms(state, now_ms=12_000.0) == 5000


def test_compute_position_playing_with_rate_half_advances_half_speed() -> None:
    """Игра с rate=0.5: за 2000 мс позиция растёт на 1000 мс."""
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=0.5,
    )
    assert compute_current_position_ms(state, now_ms=12_000.0) == 2000


# --- 2. apply_play ---


def test_apply_play_idempotent_returns_same_object_when_already_playing() -> None:
    """Идемпотентность: повторный Play на уже играющем state возвращает тот же объект."""
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    result = apply_play(state, execute_at_ms=20_000.0)
    # is-сравнение: обработчик в handler.py детектит no-op через `new is old`.
    assert result is state


def test_apply_play_transitions_from_paused_to_playing() -> None:
    """Из паузы: is_playing=True, position сохраняется, anchor = execute_at."""
    state = SessionState(
        is_playing=False,
        position_ms=5000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    result = apply_play(state, execute_at_ms=20_000.0)
    assert result.is_playing is True
    assert result.position_ms == 5000
    assert result.anchor_server_ms == 20_000.0
    assert result.playback_rate == 1.0


# --- 3. apply_pause ---


def test_apply_pause_idempotent_returns_same_object_when_already_paused() -> None:
    """Идемпотентность: повторный Pause на паузе возвращает тот же объект."""
    state = SessionState(
        is_playing=False,
        position_ms=5000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    result = apply_pause(state, execute_at_ms=20_000.0)
    assert result is state


def test_apply_pause_fixates_position_at_execute_at() -> None:
    """Из (playing, pos=1000, anchor=10000, rate=1.0) при execute_at=12000:
    позиция фиксируется на (pos + (12000-10000)*1.0) = 3000, anchor=12000.
    """
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    result = apply_pause(state, execute_at_ms=12_000.0)
    assert result.is_playing is False
    assert result.position_ms == 3000
    assert result.anchor_server_ms == 12_000.0
    assert result.playback_rate == 1.0


def test_apply_pause_fixates_position_with_rate_two() -> None:
    """Та же ситуация при rate=2.0: позиция = 1000 + 2000*2.0 = 5000."""
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=2.0,
    )
    result = apply_pause(state, execute_at_ms=12_000.0)
    assert result.is_playing is False
    assert result.position_ms == 5000
    assert result.anchor_server_ms == 12_000.0


# --- 4. apply_seek ---


@pytest.mark.parametrize("was_playing", [True, False])
def test_apply_seek_preserves_is_playing(was_playing: bool) -> None:
    """Seek не меняет is_playing — проверяем оба варианта.

    Семантика реальных плееров: seek во время игры не ставит на паузу;
    seek на паузе не запускает воспроизведение.
    """
    state = SessionState(
        is_playing=was_playing,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    result = apply_seek(state, execute_at_ms=12_000.0, new_position_ms=99_999)
    assert result.is_playing is was_playing
    assert result.position_ms == 99_999
    assert result.anchor_server_ms == 12_000.0


# --- 5. apply_set_rate ---


def test_apply_set_rate_preserves_position_continuity() -> None:
    """Непрерывность: position_at_exec считается по СТАРОМУ rate, новый anchor=execute_at,
    новый rate действует после execute_at.

    Сценарий: (playing, pos=1000, anchor=10000, rate=1.0), execute_at=12000, new_rate=2.0.
    На момент execute_at позиция по старому rate = 1000 + 2000*1.0 = 3000.
    После apply: state=(playing, pos=3000, anchor=12000, rate=2.0).
    На момент 14000 (через 2 сек после смены rate): 3000 + 2000*2.0 = 7000.
    """
    state = SessionState(
        is_playing=True,
        position_ms=1000,
        anchor_server_ms=10_000.0,
        playback_rate=1.0,
    )
    result = apply_set_rate(state, execute_at_ms=12_000.0, new_rate=2.0)
    assert result.is_playing is True
    assert result.position_ms == 3000  # рассчитано по СТАРОМУ rate
    assert result.anchor_server_ms == 12_000.0
    assert result.playback_rate == 2.0
    # Через 2 секунды после смены: летим уже на новой скорости
    assert compute_current_position_ms(result, now_ms=14_000.0) == 7000


# --- 6. Композиция Play → SetRate → Pause → Seek ---


def test_composition_play_setrate_pause_seek() -> None:
    """Серия команд проверяет, что состояние корректно эволюционирует.

    Тайминг:
    - t=10000: Play (из паузы pos=0)
    - t=12000: SetRate 2.0
    - t=15000: Pause
    - t=20000: Seek 50000

    Ожидаемые промежуточные state:
    - после Play: (playing, pos=0, anchor=10000, rate=1.0)
    - после SetRate: position на t=12000 по rate=1.0 = 0 + 2000*1.0 = 2000;
      (playing, pos=2000, anchor=12000, rate=2.0)
    - после Pause: position на t=15000 по rate=2.0 = 2000 + 3000*2.0 = 8000;
      (paused, pos=8000, anchor=15000, rate=2.0)
    - после Seek: (paused, pos=50000, anchor=20000, rate=2.0)
    """
    s0 = SessionState()  # дефолт: paused, pos=0, anchor=0, rate=1.0

    s1 = apply_play(s0, execute_at_ms=10_000.0)
    assert s1.is_playing is True
    assert s1.position_ms == 0
    assert s1.anchor_server_ms == 10_000.0
    assert s1.playback_rate == 1.0

    s2 = apply_set_rate(s1, execute_at_ms=12_000.0, new_rate=2.0)
    assert s2.is_playing is True
    assert s2.position_ms == 2000
    assert s2.anchor_server_ms == 12_000.0
    assert s2.playback_rate == 2.0

    s3 = apply_pause(s2, execute_at_ms=15_000.0)
    assert s3.is_playing is False
    assert s3.position_ms == 8000
    assert s3.anchor_server_ms == 15_000.0
    assert s3.playback_rate == 2.0

    s4 = apply_seek(s3, execute_at_ms=20_000.0, new_position_ms=50_000)
    assert s4.is_playing is False
    assert s4.position_ms == 50_000
    assert s4.anchor_server_ms == 20_000.0
    assert s4.playback_rate == 2.0


# --- Бонус: SessionStateStore lifecycle ---


def test_store_get_or_create_returns_default_then_remembers() -> None:
    store = SessionStateStore()
    assert not store.has("room1")
    s1 = store.get_or_create("room1")
    assert s1 == SessionState()  # дефолт
    assert store.has("room1")
    # повторный get_or_create возвращает тот же объект
    s2 = store.get_or_create("room1")
    assert s2 is s1


def test_store_set_and_drop() -> None:
    store = SessionStateStore()
    store.set("room1", SessionState(is_playing=True, position_ms=42))
    assert store.get_or_create("room1").position_ms == 42
    store.drop("room1")
    assert not store.has("room1")
    # drop несуществующей — no-op, не падает
    store.drop("room1")
