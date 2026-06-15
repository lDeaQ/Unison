"""Проверяет цепочку логирования: подключение → Play × 3 → отключение → /stats."""
import asyncio
import json
import time
import urllib.request

import websockets


SESSION_ID = "test-logging-001"
BASE = "http://127.0.0.1:8000"


async def run() -> None:
    uri = f"ws://127.0.0.1:8000/ws/{SESSION_ID}"
    async with websockets.connect(uri) as ws:
        # Hello
        await ws.send(json.dumps({
            "type": "Hello",
            "payload": {"session_id": SESSION_ID, "nickname": "tester"}
        }))

        # Welcome
        welcome_raw = await ws.recv()
        welcome = json.loads(welcome_raw)
        print(f"Welcome: session_id={welcome['payload']['session_id']}, "
              f"user_id={welcome['payload']['your_user_id'][:8]}...")

        # TimeSync × 2 (чтобы в events_log появились записи)
        for _ in range(2):
            await ws.send(json.dumps({
                "type": "TimeSyncRequest",
                "payload": {"client_send_ms": time.time() * 1000}
            }))
            await ws.recv()
            await asyncio.sleep(0.1)

        # Play × 3
        for i in range(3):
            await ws.send(json.dumps({
                "type": "Play",
                "payload": {"position_ms": i * 5000}
            }))
            msg = json.loads(await ws.recv())
            print(f"Play broadcast: position_ms={msg['payload']['position_ms']}")
            # Пауза между Play — иначе no-op (уже playing)
            await ws.send(json.dumps({
                "type": "Pause",
                "payload": {"position_ms": i * 5000}
            }))
            await ws.recv()
            await asyncio.sleep(0.05)

        # Seek
        await ws.send(json.dumps({
            "type": "Seek",
            "payload": {"position_ms": 120000}
        }))
        msg = json.loads(await ws.recv())
        print(f"Seek broadcast: position_ms={msg['payload']['position_ms']}")

        print("Отключаемся...")

    # Небольшая пауза — Leave должен записаться
    await asyncio.sleep(0.3)

    # Проверяем /events
    with urllib.request.urlopen(f"{BASE}/api/sessions/{SESSION_ID}/events") as r:
        events = json.loads(r.read())
    print(f"\nСобытий в /events: {len(events)}")
    for e in events:
        print(f"  [{e['event_type']:22s}] ts={e['server_timestamp_ms']:.0f}  payload={e['payload']}")

    # Проверяем /stats
    with urllib.request.urlopen(f"{BASE}/api/sessions/{SESSION_ID}/stats") as r:
        stats = json.loads(r.read())
    print(f"\n/stats:\n{json.dumps(stats, indent=2, ensure_ascii=False)}")


asyncio.run(run())
