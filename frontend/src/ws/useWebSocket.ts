import { useCallback, useEffect, useRef, useState } from 'react'
import { WSClient } from './WSClient'
import type { ConnectionStatus } from './WSClient'
import type { ParticipantInfo, WelcomePayload } from '../types/protocol'

export interface UseWebSocketResult {
  status: ConnectionStatus
  participants: ParticipantInfo[]
  myUserId: string | null
  reconnect: () => void
}

export function useWebSocket(sessionId: string, nickname: string): UseWebSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [participants, setParticipants] = useState<ParticipantInfo[]>([])
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const clientRef = useRef<WSClient | null>(null)

  useEffect(() => {
    const client = new WSClient()
    clientRef.current = client

    client.on('status_change', (s) => setStatus(s as ConnectionStatus))

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

    client.on('max_retries_exceeded', () => {
      setStatus('failed')
    })

    client.connect(sessionId, nickname)

    return () => {
      client.disconnect()
    }
  }, [sessionId, nickname])

  const reconnect = useCallback(() => {
    clientRef.current?.connect(sessionId, nickname)
  }, [sessionId, nickname])

  return { status, participants, myUserId, reconnect }
}
