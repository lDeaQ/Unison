import { useCallback, useEffect, useRef, useState } from 'react'
import { WSClient } from './WSClient'
import type { ConnectionStatus } from './WSClient'
import { ClockSync } from '../sync/ClockSync'
import type {
  ParticipantInfo,
  TimeSyncResponsePayload,
  WelcomePayload,
} from '../types/protocol'

export interface UseWebSocketResult {
  status: ConnectionStatus
  participants: ParticipantInfo[]
  myUserId: string | null
  reconnect: () => void
  clockSync: ClockSync | null
}

export function useWebSocket(sessionId: string, nickname: string): UseWebSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [participants, setParticipants] = useState<ParticipantInfo[]>([])
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [clockSync, setClockSync] = useState<ClockSync | null>(null)
  const clientRef = useRef<WSClient | null>(null)

  useEffect(() => {
    const client = new WSClient()
    clientRef.current = client

    // ClockSync создаётся ровно один раз на жизнь эффекта (= одно подключение
    // в смысле «одна пара sessionId/nickname»). Переподключения через тот же
    // клиент не пересоздают ClockSync, только reset/start.
    const clock = new ClockSync((msg) => client.send(msg))
    setClockSync(clock)

    client.on('status_change', (s) => {
      const newStatus = s as ConnectionStatus
      setStatus(newStatus)

      // Управление ClockSync по статусу WebSocket:
      //  connected → жёсткий сброс окна и запуск опроса (после реконнекта
      //  сеть могла измениться — старые измерения недостоверны).
      //  disconnected/reconnecting → стоп; накопленный offset обнулится
      //  при следующем reset().
      if (newStatus === 'connected') {
        clock.reset()
        clock.start()
      } else if (newStatus === 'disconnected' || newStatus === 'reconnecting') {
        clock.stop()
      }
    })

    client.on('message:Welcome', (payload) => {
      const p = payload as WelcomePayload
      setMyUserId(p.your_user_id)
      setParticipants(p.participants)
    })

    client.on('message:ParticipantJoined', (payload) => {
      setParticipants((prev) => [...prev, payload as ParticipantInfo])
    })

    client.on('message:ParticipantLeft', (payload) => {
      const { id } = payload as { id: string; nickname: string }
      setParticipants((prev) => prev.filter((p) => p.id !== id))
    })

    client.on('message:TimeSyncResponse', (payload) => {
      clock.handleResponse(payload as TimeSyncResponsePayload)
    })

    client.on('message:Error', (payload) => {
      const err = payload as { code: string; message: string }
      // Согласовано: на Error в ответ на TimeSyncRequest — warn и продолжаем.
      // Все остальные Error тоже логируем единообразно.
      console.warn('[server Error]', err.code, err.message)
    })

    client.on('max_retries_exceeded', () => {
      setStatus('failed')
    })

    client.connect(sessionId, nickname)

    return () => {
      clock.stop()
      client.disconnect()
    }
  }, [sessionId, nickname])

  const reconnect = useCallback(() => {
    clientRef.current?.connect(sessionId, nickname)
  }, [sessionId, nickname])

  return { status, participants, myUserId, reconnect, clockSync }
}
