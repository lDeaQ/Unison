"""
Нагрузочный тест механизма синхронизации.

Эмулирует N WebSocket-клиентов (ботов) в одной сессии.
Каждые 10 секунд запускает измерение рассинхрона через POST /api/sessions/.../measure.
Логирует результаты в CSV.

Использование:
    python scripts/load_test.py --clients 10 --duration 60 --url ws://localhost:8000
    python scripts/load_test.py --clients 30 --duration 120 --url wss://unisonSibFU.mooo.com

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
from datetime import datetime
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

# URL тестового видео (RuTube — не используется в ботах, но нужен для запуска Play)
_TEST_VIDEO_URL = "https://rutube.ru/video/3fe74fc6e4127a1b6c1987cc3b2f8a7c/"
_MEASURE_INTERVAL_SEC = 10
_NTP_INTERVAL_SEC = 5
_NTP_WINDOW = 4          # измерений для медианы offset
_MEASURE_LEAD_MS = 500.0 # должно совпадать с сервером


# ---------------------------------------------------------------------------
# Вспомогательные функции
# ---------------------------------------------------------------------------

def local_now_ms() -> float:
    """Монотонное время в миллисекундах (аналог performance.now() в браузере)."""
    return time.monotonic() * 1000


def wall_now_ms() -> float:
    """Wall-clock Unix ms (аналог Date.now())."""
    return time.time() * 1000


def compute_position_ms(
    is_playing: bool,
    position_ms: int,
    anchor_local_ms: float,
    playback_rate: float,
    now_local_ms: float,
) -> int:
    if not is_playing:
        return position_ms
    return int(position_ms + (now_local_ms - anchor_local_ms) * playback_rate)


# ---------------------------------------------------------------------------
# Бот
# ---------------------------------------------------------------------------

@dataclass
class BotState:
    bot_id: int
    nickname: str
    is_leader: bool  # первый бот управляет воспроизведением

    # NTP
    clock_offset_ms: float = 0.0         # server_ms ≈ local_now_ms() + clock_offset_ms
    ntp_measurements: list[float] = field(default_factory=list)
    ntp_ready: bool = False

    # Playback state
    is_playing: bool = False
    position_ms: int = 0
    anchor_local_ms: float = 0.0
    playback_rate: float = 1.0

    # Идентификатор пользователя, полученный от сервера
    user_id: Optional[str] = None

    def server_now_ms(self) -> float:
        return local_now_ms() + self.clock_offset_ms

    def current_position_ms(self) -> int:
        return compute_position_ms(
            self.is_playing, self.position_ms,
            self.anchor_local_ms, self.playback_rate,
            local_now_ms(),
        )

    def position_at(self, local_ms: float) -> int:
        return compute_position_ms(
            self.is_playing, self.position_ms,
            self.anchor_local_ms, self.playback_rate,
            local_ms,
        )


async def run_bot(
    bot_id: int,
    ws_url: str,
    session_id: str,
    is_leader: bool,
    stop_event: asyncio.Event,
    results_queue: asyncio.Queue,
    connected_event: asyncio.Event,
) -> None:
    nickname = f"bot_{bot_id}"
    state = BotState(bot_id=bot_id, nickname=nickname, is_leader=is_leader)

    # Очередь исходящих сообщений (NTP шлём из отдельной задачи)
    send_queue: asyncio.Queue[str] = asyncio.Queue()

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

    async def ntp_loop(ws: websockets.WebSocketClientProtocol) -> None:
        while not stop_event.is_set():
            t0 = local_now_ms()
            enqueue({"type": "TimeSyncRequest", "payload": {"client_send_ms": t0}})
            await asyncio.sleep(_NTP_INTERVAL_SEC)

    def handle_message(raw: str) -> None:
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            return
        msg_type = msg.get("type")
        payload = msg.get("payload", {})

        if msg_type == "Welcome":
            state.user_id = payload.get("your_user_id")
            state.is_playing = payload.get("is_playing", False)
            state.position_ms = payload.get("position_ms", 0)
            state.playback_rate = payload.get("playback_rate", 1.0)
            state.anchor_local_ms = local_now_ms()
            logger.debug("Bot %d: Welcome получен, user_id=%s", bot_id, state.user_id)

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
            logger.debug(
                "Bot %d: NTP offset=%.1fms rtt=%.1fms", bot_id, state.clock_offset_ms, rtt
            )

        elif msg_type == "Play":
            execute_at_local = payload["execute_at_ms"] - state.clock_offset_ms
            delay_ms = execute_at_local - local_now_ms()
            def apply_play(eat=execute_at_local, pos=payload.get("position_ms", 0)):
                state.is_playing = True
                state.position_ms = pos
                state.anchor_local_ms = eat
            if delay_ms > 0:
                asyncio.get_event_loop().call_later(delay_ms / 1000, apply_play)
            else:
                apply_play()

        elif msg_type == "Pause":
            execute_at_local = payload["execute_at_ms"] - state.clock_offset_ms
            def apply_pause(eat=execute_at_local, pos=payload.get("position_ms", 0)):
                state.is_playing = False
                state.position_ms = pos
                state.anchor_local_ms = eat
            delay_ms = execute_at_local - local_now_ms()
            if delay_ms > 0:
                asyncio.get_event_loop().call_later(delay_ms / 1000, apply_pause)
            else:
                apply_pause()

        elif msg_type == "Seek":
            execute_at_local = payload["execute_at_ms"] - state.clock_offset_ms
            new_pos = payload.get("position_ms", 0)
            def apply_seek(eat=execute_at_local, pos=new_pos):
                state.position_ms = pos
                state.anchor_local_ms = eat
            delay_ms = execute_at_local - local_now_ms()
            if delay_ms > 0:
                asyncio.get_event_loop().call_later(delay_ms / 1000, apply_seek)
            else:
                apply_seek()

        elif msg_type == "PersonalPlay":
            execute_at_local = payload["execute_at_ms"] - state.clock_offset_ms
            new_pos = payload.get("position_ms", 0)
            def apply_personal_play(eat=execute_at_local, pos=new_pos):
                state.is_playing = True
                state.position_ms = pos
                state.anchor_local_ms = eat
            delay_ms = execute_at_local - local_now_ms()
            if delay_ms > 0:
                asyncio.get_event_loop().call_later(delay_ms / 1000, apply_personal_play)
            else:
                apply_personal_play()

        elif msg_type == "MeasureSync":
            measure_at_ms = payload.get("measure_at_ms", 0.0)
            if not state.ntp_ready:
                return
            measure_at_local = measure_at_ms - state.clock_offset_ms
            delay_ms = measure_at_local - local_now_ms()

            def do_measure(mat_ms=measure_at_ms, mat_local=measure_at_local):
                pos = state.position_at(mat_local)
                if pos <= 0:
                    return
                enqueue({
                    "type": "SyncMeasurement",
                    "payload": {"position_ms": pos, "measure_at_ms": mat_ms},
                })
                results_queue.put_nowait({
                    "bot_id": bot_id,
                    "measure_at_ms": mat_ms,
                    "position_ms": pos,
                })
                logger.debug("Bot %d: SyncMeasurement отправлен pos=%d", bot_id, pos)

            if delay_ms > 0 and delay_ms < 5000:
                asyncio.get_event_loop().call_later(delay_ms / 1000, do_measure)
            elif delay_ms >= -500:
                do_measure()

    try:
        async with websockets.connect(ws_url) as ws:
            logger.info("Bot %d (%s): подключён", bot_id, nickname)

            # Запускаем задачи отправки и NTP
            sender_task = asyncio.create_task(sender(ws))
            ntp_task = asyncio.create_task(ntp_loop(ws))

            # Hello
            enqueue({
                "type": "Hello",
                "payload": {"session_id": session_id, "nickname": nickname},
            })

            # Ждём Welcome (первое сообщение от сервера)
            raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
            handle_message(raw)
            connected_event.set()

            # Лидер: запускает видео через 2 секунды после подключения всех ботов
            if is_leader:
                # Даём остальным подключиться (connected_event сигнализирует только о себе;
                # stop_event не установлен — просто ждём паузу)
                await asyncio.sleep(3.0)
                enqueue({
                    "type": "SetVideoUrl",
                    "payload": {"video_url": _TEST_VIDEO_URL},
                })
                await asyncio.sleep(0.5)
                enqueue({
                    "type": "Play",
                    "payload": {"position_ms": 0},
                })
                logger.info("Bot %d (лидер): SetVideoUrl + Play отправлены", bot_id)

            # Основной цикл получения сообщений
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

    except Exception as e:
        logger.error("Bot %d: ошибка — %s", bot_id, e)
    finally:
        logger.info("Bot %d: завершён", bot_id)


# ---------------------------------------------------------------------------
# Оркестратор
# ---------------------------------------------------------------------------

async def run_load_test(
    n_clients: int,
    duration_sec: int,
    base_url: str,
    session_id: str,
    output_csv: Path,
) -> None:
    # Определяем HTTP URL из WS URL
    http_base = base_url.replace("wss://", "https://").replace("ws://", "http://")
    ws_url = f"{base_url}/ws/{session_id}"

    logger.info(
        "Старт: %d клиентов, %d сек, сессия=%s", n_clients, duration_sec, session_id
    )

    stop_event = asyncio.Event()
    results_queue: asyncio.Queue = asyncio.Queue()

    # Запускаем всех ботов
    connected_events = [asyncio.Event() for _ in range(n_clients)]
    bot_tasks = []
    for i in range(n_clients):
        t = asyncio.create_task(
            run_bot(
                bot_id=i,
                ws_url=ws_url,
                session_id=session_id,
                is_leader=(i == 0),
                stop_event=stop_event,
                results_queue=results_queue,
                connected_event=connected_events[i],
            )
        )
        bot_tasks.append(t)
        # Небольшой jitter между подключениями — не DDOSим сервер
        await asyncio.sleep(0.05)

    # Ждём подключения всех ботов (с таймаутом)
    logger.info("Ждём подключения %d ботов...", n_clients)
    try:
        await asyncio.wait_for(
            asyncio.gather(*[e.wait() for e in connected_events]),
            timeout=30.0,
        )
    except asyncio.TimeoutError:
        connected = sum(1 for e in connected_events if e.is_set())
        logger.warning("Таймаут подключения: подключилось %d из %d", connected, n_clients)

    # Даём лидеру запустить видео
    await asyncio.sleep(4.0)
    logger.info("Все боты подключены, начинаем измерения")

    # CSV-файл
    csv_rows = []
    start_wall = time.time()

    # Цикл измерений
    elapsed = 0.0
    async with httpx.AsyncClient(timeout=10.0) as http:
        while elapsed < duration_sec:
            await asyncio.sleep(_MEASURE_INTERVAL_SEC)
            elapsed = time.time() - start_wall
            if elapsed >= duration_sec:
                break

            # Триггер измерения
            try:
                resp = await http.post(
                    f"{http_base}/api/sessions/{session_id}/measure"
                )
                if resp.status_code == 200:
                    data = resp.json()
                    logger.info(
                        "MeasureSync разослан %d клиентам, measure_at_ms=%.1f",
                        data.get("clients_notified", 0),
                        data.get("measure_at_ms", 0),
                    )
                else:
                    logger.warning("POST /measure вернул %d: %s", resp.status_code, resp.text)
            except Exception as e:
                logger.error("Ошибка POST /measure: %s", e)
                continue

            # Ждём ответов от ботов (measure_at + 200мс буфер)
            await asyncio.sleep(_MEASURE_LEAD_MS / 1000 + 0.5)

            # Получаем накопленные результаты из очереди
            local_results: list[dict] = []
            while not results_queue.empty():
                local_results.append(results_queue.get_nowait())

            # Группируем по measure_at_ms
            groups: dict[float, list[int]] = {}
            for r in local_results:
                key = round(r["measure_at_ms"], 0)
                groups.setdefault(key, []).append(r["position_ms"])

            for mat_ms, positions in groups.items():
                if len(positions) < 2:
                    continue
                min_pos = min(positions)
                max_pos = max(positions)
                desync_ms = max_pos - min_pos
                ts = datetime.utcnow().isoformat()
                row = {
                    "timestamp": ts,
                    "n_clients": n_clients,
                    "responding": len(positions),
                    "min_pos_ms": min_pos,
                    "max_pos_ms": max_pos,
                    "desync_ms": desync_ms,
                    "measure_at_ms": mat_ms,
                }
                csv_rows.append(row)
                status = "OK" if desync_ms <= 400 else "FAIL"
                logger.info(
                    "[%s] n=%d respond=%d min=%d max=%d desync=%d мс",
                    status, n_clients, len(positions), min_pos, max_pos, desync_ms,
                )

    # Остановка ботов
    stop_event.set()
    await asyncio.gather(*bot_tasks, return_exceptions=True)

    # Записываем итоговые данные из сервера (более полные — ботам могли прийти дополнительные ответы)
    logger.info("Запрашиваем итоговую статистику с сервера...")
    try:
        async with httpx.AsyncClient(timeout=10.0) as http:
            resp = await http.get(
                f"{http_base}/api/sessions/{session_id}/sync-measurements"
            )
            if resp.status_code == 200:
                server_data = resp.json()
                server_groups = server_data.get("groups", [])
                logger.info("Итого групп измерений на сервере: %d", len(server_groups))
                if server_groups:
                    desync_values = [g["desync_ms"] for g in server_groups if g["count"] >= 2]
                    if desync_values:
                        logger.info(
                            "Рассинхрон: min=%d мс, max=%d мс, avg=%.0f мс (из %d групп с ≥2 ответами)",
                            min(desync_values),
                            max(desync_values),
                            sum(desync_values) / len(desync_values),
                            len(desync_values),
                        )
                    # Дополняем CSV серверными данными если скрипт не собрал их сам
                    if not csv_rows:
                        for g in server_groups:
                            if g["count"] >= 2:
                                csv_rows.append({
                                    "timestamp": datetime.utcnow().isoformat(),
                                    "n_clients": n_clients,
                                    "responding": g["count"],
                                    "min_pos_ms": g["min_pos_ms"],
                                    "max_pos_ms": g["max_pos_ms"],
                                    "desync_ms": g["desync_ms"],
                                    "measure_at_ms": g["measure_at_ms"],
                                })
    except Exception as e:
        logger.error("Ошибка получения статистики: %s", e)

    # Запись CSV
    if csv_rows:
        output_csv.parent.mkdir(parents=True, exist_ok=True)
        with open(output_csv, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=list(csv_rows[0].keys()))
            writer.writeheader()
            writer.writerows(csv_rows)
        logger.info("Результаты записаны в %s (%d строк)", output_csv, len(csv_rows))
    else:
        logger.warning("Нет данных для записи в CSV — возможно, видео не воспроизводилось")

    logger.info("Тест завершён.")


# ---------------------------------------------------------------------------
# Точка входа
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Нагрузочный тест механизма синхронизации"
    )
    parser.add_argument(
        "--clients", type=int, default=5,
        help="Количество клиентов-ботов (default: 5)",
    )
    parser.add_argument(
        "--duration", type=int, default=60,
        help="Длительность теста в секундах (default: 60)",
    )
    parser.add_argument(
        "--url", type=str, default="ws://localhost:8000",
        help="Базовый WebSocket URL сервера (default: ws://localhost:8000)",
    )
    parser.add_argument(
        "--session", type=str, default=None,
        help="ID сессии (default: load_test_<timestamp>)",
    )
    parser.add_argument(
        "--output", type=str, default="results/load_test.csv",
        help="Путь к CSV-файлу с результатами (default: results/load_test.csv)",
    )
    parser.add_argument(
        "--verbose", action="store_true",
        help="Подробное логирование (DEBUG уровень)",
    )
    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    session_id = args.session or f"load_test_{int(time.time())}"
    output_csv = Path(args.output)

    try:
        asyncio.run(
            run_load_test(
                n_clients=args.clients,
                duration_sec=args.duration,
                base_url=args.url.rstrip("/"),
                session_id=session_id,
                output_csv=output_csv,
            )
        )
    except KeyboardInterrupt:
        logger.info("Прерван пользователем.")
        sys.exit(0)


if __name__ == "__main__":
    main()
