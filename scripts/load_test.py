"""
Нагрузочный тест механизма синхронизации.

Эмулирует N WebSocket-клиентов (ботов) в одной сессии.
Каждые 10 секунд запускает измерение рассинхрона через POST /api/sessions/.../measure.
Логирует результаты в CSV.

Использование:
    python scripts/load_test.py --clients 10 --duration 60
    python scripts/load_test.py --clients 30 --duration 120 --url wss://unisonSibFU.mooo.com
    python scripts/load_test.py --clients 5 --session demo --video ""

Зависимости:
    pip install websockets httpx
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import httpx
import websockets
from websockets.exceptions import ConnectionClosed

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("load_test")

_MEASURE_INTERVAL_SEC = 10
_NTP_INTERVAL_SEC = 5
_NTP_WINDOW = 4           # измерений в окне для медианы offset
_MEASURE_LEAD_MS = 500.0  # должно совпадать с сервером


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def local_now_ms() -> float:
    """Монотонное время в мс — аналог performance.now() в браузере."""
    return time.monotonic() * 1000


# ---------------------------------------------------------------------------
# Состояние бота
# ---------------------------------------------------------------------------

@dataclass
class BotState:
    bot_id: int
    nickname: str
    is_leader: bool

    # NTP: оценка смещения local_now_ms() относительно серверного времени
    clock_offset_ms: float = 0.0
    ntp_measurements: list[float] = field(default_factory=list)
    ntp_ready: bool = False

    # Упрощённая модель воспроизведения: позиция = local_now_ms() - play_started_at_local
    # None означает, что плеер ещё не играет — бот не отвечает на MeasureSync
    play_started_at_local: Optional[float] = None

    user_id: Optional[str] = None

    def server_now_ms(self) -> float:
        """Оценка текущего серверного времени в мс."""
        return local_now_ms() + self.clock_offset_ms

    def position_at_local(self, local_ms: float) -> Optional[int]:
        """Позиция плеера в момент local_ms. None если не играем."""
        if self.play_started_at_local is None:
            return None
        pos = int(local_ms - self.play_started_at_local)
        return pos if pos > 0 else None


# ---------------------------------------------------------------------------
# Один бот
# ---------------------------------------------------------------------------

async def run_bot(
    bot_id: int,
    ws_url: str,
    session_id: str,
    is_leader: bool,
    video_url: str,
    stop_event: asyncio.Event,
    results_queue: asyncio.Queue,
    connected_event: asyncio.Event,
    all_connected_event: asyncio.Event,
) -> None:
    nickname = f"bot_{bot_id}"
    state = BotState(bot_id=bot_id, nickname=nickname, is_leader=is_leader)

    send_queue: asyncio.Queue[Optional[str]] = asyncio.Queue()

    async def sender(ws: websockets.WebSocketClientProtocol) -> None:
        while True:
            msg = await send_queue.get()
            if msg is None:
                return
            try:
                await ws.send(msg)
            except ConnectionClosed:
                return

    def enqueue(msg: dict) -> None:
        send_queue.put_nowait(json.dumps(msg))

    async def ntp_loop() -> None:
        while not stop_event.is_set():
            t0 = local_now_ms()
            enqueue({"type": "TimeSyncRequest", "payload": {"client_send_ms": t0}})
            await asyncio.sleep(_NTP_INTERVAL_SEC)

    def set_play_started(execute_at_ms: float) -> None:
        """Вычисляет и (возможно, отложенно) устанавливает play_started_at_local."""
        remaining_ms = execute_at_ms - state.server_now_ms()
        if remaining_ms > 0:
            # Ставим таймер: в момент execute_at устанавливаем точку старта
            def _apply():
                state.play_started_at_local = local_now_ms()
            asyncio.get_event_loop().call_later(remaining_ms / 1000, _apply)
        else:
            # execute_at уже прошёл: откатываемся назад на |remaining|
            state.play_started_at_local = local_now_ms() + remaining_ms

    def handle_message(raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        msg_type = msg.get("type")
        payload = msg.get("payload", {})

        if msg_type == "Welcome":
            state.user_id = payload.get("your_user_id")
            logger.debug("Bot %d: Welcome user_id=%s", bot_id, state.user_id)

        elif msg_type == "TimeSyncResponse":
            t3 = local_now_ms()
            t0 = payload.get("client_send_ms", t3)
            t1 = payload.get("server_receive_ms", t3)
            t2 = payload.get("server_send_ms", t3)
            rtt = (t3 - t0) - (t2 - t1)
            offset = ((t1 - t0) + (t2 - t3)) / 2
            state.ntp_measurements.append(offset)
            if len(state.ntp_measurements) > _NTP_WINDOW:
                state.ntp_measurements = state.ntp_measurements[-_NTP_WINDOW:]
            sorted_m = sorted(state.ntp_measurements)
            state.clock_offset_ms = sorted_m[len(sorted_m) // 2]
            if not state.ntp_ready and len(state.ntp_measurements) >= 2:
                state.ntp_ready = True
            logger.debug("Bot %d: NTP offset=%.1fms rtt=%.1fms", bot_id, state.clock_offset_ms, rtt)

        elif msg_type == "Play":
            execute_at_ms = payload.get("execute_at_ms", state.server_now_ms())
            set_play_started(execute_at_ms)
            logger.debug("Bot %d: Play execute_at=%.1f", bot_id, execute_at_ms)

        elif msg_type == "PersonalPlay":
            # Персональный старт при входе в играющую сессию
            execute_at_ms = payload.get("execute_at_ms", state.server_now_ms())
            set_play_started(execute_at_ms)
            logger.debug("Bot %d: PersonalPlay execute_at=%.1f", bot_id, execute_at_ms)

        elif msg_type == "Pause":
            state.play_started_at_local = None
            logger.debug("Bot %d: Pause — play_started_at сброшен", bot_id)

        elif msg_type == "VideoUrlChanged":
            # Смена видео сбрасывает воспроизведение
            state.play_started_at_local = None

        elif msg_type == "MeasureSync":
            measure_at_ms = payload.get("measure_at_ms", 0.0)
            if not state.ntp_ready:
                logger.debug("Bot %d: MeasureSync пропущен (NTP не готов)", bot_id)
                return

            # Момент измерения в локальном времени
            measure_at_local = measure_at_ms - state.clock_offset_ms
            delay_ms = measure_at_local - local_now_ms()

            def do_measure(mat_ms: float = measure_at_ms, mat_local: float = measure_at_local) -> None:
                pos = state.position_at_local(mat_local)
                if pos is None:
                    logger.debug("Bot %d: MeasureSync пропущен (плеер не играет)", bot_id)
                    return
                enqueue({
                    "type": "SyncMeasurement",
                    "payload": {"position_ms": pos, "measure_at_ms": mat_ms},
                })
                results_queue.put_nowait({
                    "measure_at_ms": mat_ms,
                    "position_ms": pos,
                })
                logger.debug("Bot %d: SyncMeasurement pos=%d ms", bot_id, pos)

            if 0 < delay_ms < 5000:
                asyncio.get_event_loop().call_later(delay_ms / 1000, do_measure)
            elif delay_ms >= -500:
                do_measure()
            # иначе команда слишком старая — игнорируем

    try:
        async with websockets.connect(ws_url) as ws:
            logger.info("Bot %d (%s): подключён", bot_id, nickname)

            sender_task = asyncio.create_task(sender(ws))
            ntp_task = asyncio.create_task(ntp_loop())

            enqueue({
                "type": "Hello",
                "payload": {"session_id": session_id, "nickname": nickname},
            })

            # Ждём Welcome
            raw = await asyncio.wait_for(ws.recv(), timeout=15.0)
            handle_message(raw)
            connected_event.set()

            # Лидер запускает видео после того как все подключились
            if is_leader:
                await asyncio.wait_for(all_connected_event.wait(), timeout=60.0)
                await asyncio.sleep(3.0)  # пауза на стабилизацию соединений

                if video_url:
                    enqueue({"type": "SetVideoUrl", "payload": {"video_url": video_url}})
                    logger.info("Bot 0 (лидер): SetVideoUrl '%s'", video_url)
                    await asyncio.sleep(0.5)

                enqueue({"type": "Play", "payload": {"position_ms": 0}})
                logger.info("Bot 0 (лидер): Play отправлен")

            # Основной цикл
            while not stop_event.is_set():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    handle_message(raw)
                except asyncio.TimeoutError:
                    continue
                except ConnectionClosed:
                    logger.warning("Bot %d: соединение закрыто сервером", bot_id)
                    break

            send_queue.put_nowait(None)
            await sender_task
            ntp_task.cancel()
            try:
                await ntp_task
            except asyncio.CancelledError:
                pass

    except asyncio.TimeoutError:
        logger.error("Bot %d: таймаут ожидания Welcome", bot_id)
    except Exception as e:
        logger.error("Bot %d: ошибка — %s", bot_id, e)
    finally:
        logger.debug("Bot %d: завершён", bot_id)


# ---------------------------------------------------------------------------
# Оркестратор
# ---------------------------------------------------------------------------

async def run_load_test(
    n_clients: int,
    duration_sec: int,
    base_url: str,
    session_id: str,
    video_url: str,
    output_csv: Path,
) -> None:
    http_base = base_url.replace("wss://", "https://").replace("ws://", "http://")
    ws_url = f"{base_url}/ws/{session_id}"

    logger.info(
        "Старт: %d клиентов, %d сек, url=%s, сессия=%s",
        n_clients, duration_sec, base_url, session_id,
    )
    if video_url:
        logger.info("Видео: %s", video_url)
    else:
        logger.info("--video не задан: лидер только отправит Play (видео должно быть загружено)")

    stop_event = asyncio.Event()
    results_queue: asyncio.Queue = asyncio.Queue()
    connected_events = [asyncio.Event() for _ in range(n_clients)]
    all_connected_event = asyncio.Event()

    async def wait_all_connected() -> None:
        await asyncio.gather(*[e.wait() for e in connected_events])
        all_connected_event.set()

    asyncio.create_task(wait_all_connected())

    # Запуск ботов с небольшим jitter между подключениями
    bot_tasks = []
    for i in range(n_clients):
        t = asyncio.create_task(
            run_bot(
                bot_id=i,
                ws_url=ws_url,
                session_id=session_id,
                is_leader=(i == 0),
                video_url=video_url,
                stop_event=stop_event,
                results_queue=results_queue,
                connected_event=connected_events[i],
                all_connected_event=all_connected_event,
            )
        )
        bot_tasks.append(t)
        await asyncio.sleep(0.05)

    # Ждём подключения всех ботов (с таймаутом)
    logger.info("Ждём подключения %d ботов...", n_clients)
    try:
        await asyncio.wait_for(all_connected_event.wait(), timeout=60.0)
        connected_count = sum(1 for e in connected_events if e.is_set())
        logger.info("Подключилось %d / %d ботов", connected_count, n_clients)
    except asyncio.TimeoutError:
        connected_count = sum(1 for e in connected_events if e.is_set())
        logger.warning("Таймаут: подключилось только %d / %d", connected_count, n_clients)

    # После подключения: 3 сек (стабилизация) + Play от лидера + 5 сек на буферизацию
    # Лидер сам добавляет 3 сек внутри; мы ждём ещё 5 сек после него
    wait_before_measure = 3.0 + (0.5 if video_url else 0) + 0.2 + 5.0
    logger.info("Ждём %.0f сек на буферизацию видео перед первым измерением...", wait_before_measure)
    await asyncio.sleep(wait_before_measure)

    # Цикл измерений
    csv_rows: list[dict] = []
    start_wall = time.monotonic()

    async with httpx.AsyncClient(timeout=10.0) as http:
        measure_num = 0
        while time.monotonic() - start_wall < duration_sec:
            measure_num += 1
            logger.info("=== Измерение #%d ===", measure_num)

            # Триггер на сервере
            try:
                resp = await http.post(f"{http_base}/api/sessions/{session_id}/measure")
                if resp.status_code == 200:
                    data = resp.json()
                    measure_at_ms = data.get("measure_at_ms", 0)
                    notified = data.get("clients_notified", 0)
                    logger.info("MeasureSync разослан %d клиентам (measure_at_ms=%.1f)", notified, measure_at_ms)
                else:
                    logger.warning("POST /measure → %d: %s", resp.status_code, resp.text[:200])
                    await asyncio.sleep(_MEASURE_INTERVAL_SEC)
                    continue
            except Exception as e:
                logger.error("POST /measure: %s", e)
                await asyncio.sleep(_MEASURE_INTERVAL_SEC)
                continue

            # Ждём: measure_at + буфер на RTT и обработку
            await asyncio.sleep(_MEASURE_LEAD_MS / 1000 + 0.8)

            # Собираем ответы ботов из очереди
            positions: list[int] = []
            while not results_queue.empty():
                item = results_queue.get_nowait()
                # Берём только ответы на текущее измерение (±1000 мс)
                if abs(item["measure_at_ms"] - measure_at_ms) < 1000:
                    positions.append(item["position_ms"])

            if len(positions) >= 2:
                min_pos = min(positions)
                max_pos = max(positions)
                desync_ms = max_pos - min_pos
                status = "OK  " if desync_ms <= 400 else "FAIL"
                logger.info(
                    "[%s] ответило=%d/%d  min=%d мс  max=%d мс  desync=%d мс",
                    status, len(positions), n_clients, min_pos, max_pos, desync_ms,
                )
                csv_rows.append({
                    "measure_at_ms": round(measure_at_ms, 1),
                    "n_clients": n_clients,
                    "n_responses": len(positions),
                    "min_pos_ms": min_pos,
                    "max_pos_ms": max_pos,
                    "desync_ms": desync_ms,
                })
            elif len(positions) == 1:
                logger.warning("Только 1 ответ на измерение — рассинхрон неизмерим")
            else:
                logger.warning("Нет ответов на измерение (боты не играют?)")

            # Пауза до следующего измерения
            elapsed = time.monotonic() - start_wall
            remaining = _MEASURE_INTERVAL_SEC - (_MEASURE_LEAD_MS / 1000 + 0.8)
            sleep_time = max(0, remaining - 0.1)
            if elapsed + sleep_time >= duration_sec:
                break
            await asyncio.sleep(sleep_time)

    # Останавливаем ботов
    stop_event.set()
    await asyncio.gather(*bot_tasks, return_exceptions=True)
    logger.info("Все боты остановлены.")

    # Финальная статистика
    if csv_rows:
        desync_values = [r["desync_ms"] for r in csv_rows]
        logger.info(
            "Итог: %d измерений | desync min=%d мс, max=%d мс, avg=%.0f мс",
            len(csv_rows),
            min(desync_values),
            max(desync_values),
            sum(desync_values) / len(desync_values),
        )
        pass_count = sum(1 for d in desync_values if d <= 400)
        logger.info(
            "Целевой показатель ≤400 мс: %d/%d измерений (%.0f%%)",
            pass_count, len(desync_values),
            100 * pass_count / len(desync_values),
        )

    # Запись CSV
    if csv_rows:
        output_csv.parent.mkdir(parents=True, exist_ok=True)
        with open(output_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=["measure_at_ms", "n_clients", "n_responses", "min_pos_ms", "max_pos_ms", "desync_ms"])
            writer.writeheader()
            writer.writerows(csv_rows)
        logger.info("CSV записан: %s (%d строк)", output_csv, len(csv_rows))
    else:
        logger.warning("Нет данных для CSV — боты не отвечали на MeasureSync")


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Нагрузочный тест механизма синхронизации"
    )
    parser.add_argument("--clients", type=int, default=5,
                        help="Количество ботов (default: 5)")
    parser.add_argument("--duration", type=int, default=60,
                        help="Длительность теста в секундах (default: 60)")
    parser.add_argument("--url", type=str, default="ws://localhost:8000",
                        help="Базовый WS URL сервера (default: ws://localhost:8000)")
    parser.add_argument("--session", type=str, default=None,
                        help="ID сессии (default: load_test_<timestamp>). "
                             "Передай --session demo чтобы войти в существующую комнату.")
    parser.add_argument("--video", type=str, default="https://rutube.ru/video/6fa7f6dd531f8477f291d30f2fead36f/",
                        help="URL видео для SetVideoUrl (default: тестовое RuTube видео). "
                             "Пустая строка — не отправлять SetVideoUrl.")
    parser.add_argument("--output", type=str, default=None,
                        help="Путь к CSV (default: scripts/load_test_results_<timestamp>.csv)")
    parser.add_argument("--verbose", action="store_true",
                        help="DEBUG логирование")
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    session_id = args.session or f"load_test_{int(time.time())}"
    ts = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    output_csv = Path(args.output) if args.output else Path(f"scripts/load_test_results_{ts}.csv")

    try:
        asyncio.run(
            run_load_test(
                n_clients=args.clients,
                duration_sec=args.duration,
                base_url=args.url.rstrip("/"),
                session_id=session_id,
                video_url=args.video,
                output_csv=output_csv,
            )
        )
    except KeyboardInterrupt:
        logger.info("Прерван пользователем.")
        sys.exit(0)


if __name__ == "__main__":
    main()
