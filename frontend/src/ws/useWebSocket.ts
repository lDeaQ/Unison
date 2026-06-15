import { useCallback, useEffect, useRef, useState } from 'react'
import { WSClient } from './WSClient'
import type { ConnectionStatus } from './WSClient'
import { ClockSync } from '../sync/ClockSync'
import { PlaybackSync } from '../playback/PlaybackSync'
import type {
  ChatMessageBroadcastPayload,
  ParticipantInfo,
  PersonalPlayPayload,
  Role,
  RoleChangedPayload,
  TimeSyncResponsePayload,
  WelcomePayload,
  PlayBroadcastPayload,
  PauseBroadcastPayload,
  SeekBroadcastPayload,
  SetPlaybackRateBroadcastPayload,
  VideoUrlChangedPayload,
} from '../types/protocol'

export interface UseWebSocketResult {
  status: ConnectionStatus
  participants: ParticipantInfo[]
  myUserId: string | null
  myRole: Role | null
  videoUrl: string
  roomClosed: boolean
  reconnect: () => void
  sendSetVideoUrl: (url: string) => void
  sendGrantAdmin: (targetUserId: string) => void
  sendRevokeAdmin: (targetUserId: string) => void
  sendCloseRoom: () => void
  clockSync: ClockSync | null
  playbackSync: PlaybackSync | null
  messages: ChatMessageBroadcastPayload[]
  sendChat: (text: string) => void
  isSyncing: boolean
}

export function useWebSocket(sessionId: string, nickname: string): UseWebSocketResult {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected')
  const [participants, setParticipants] = useState<ParticipantInfo[]>([])
  const [myUserId, setMyUserId] = useState<string | null>(null)
  const [myRole, setMyRole] = useState<Role | null>(null)
  const [videoUrl, setVideoUrl] = useState<string>('')
  const [roomClosed, setRoomClosed] = useState(false)
  const [clockSync, setClockSync] = useState<ClockSync | null>(null)
  const [playbackSync, setPlaybackSync] = useState<PlaybackSync | null>(null)
  const [messages, setMessages] = useState<ChatMessageBroadcastPayload[]>([])
  const [isSyncing, setIsSyncing] = useState(false)
  const clientRef = useRef<WSClient | null>(null)
  // Ref для доступа к myUserId внутри WS-колбэков без stale closure
  const myUserIdRef = useRef<string | null>(null)

  useEffect(() => {
    const client = new WSClient()
    clientRef.current = client

    const clock = new ClockSync((msg) => client.send(msg))
    setClockSync(clock)

    const playback = new PlaybackSync(
      (msg) => client.send(msg),
      () => clock.getOffset(),
      () => clock.isReady(),
    )
    setPlaybackSync(playback)
    playback.onSynced(() => setIsSyncing(false))

    client.on('status_change', (s) => {
      const newStatus = s as ConnectionStatus
      setStatus(newStatus)

      if (newStatus === 'connected') {
        clock.reset()
        clock.start()
      } else if (newStatus === 'disconnected' || newStatus === 'reconnecting') {
        clock.stop()
      }
    })

    client.on('message:Welcome', (payload) => {
      const p = payload as WelcomePayload
      myUserIdRef.current = p.your_user_id
      setMyUserId(p.your_user_id)
      setParticipants(p.participants)
      setVideoUrl(p.video_url)
      // Определяем собственную роль из списка участников
      const myInfo = p.participants.find((pt) => pt.id === p.your_user_id)
      setMyRole(myInfo?.role ?? 'participant')
      playback.onWelcome(p)
      setIsSyncing(p.is_playing)
    })

    client.on('message:VideoUrlChanged', (payload) => {
      const p = payload as VideoUrlChangedPayload
      setVideoUrl(p.video_url)
      playback.onVideoUrlChanged()
    })

    client.on('message:ParticipantJoined', (payload) => {
      setParticipants((prev) => [...prev, payload as ParticipantInfo])
    })

    client.on('message:ParticipantLeft', (payload) => {
      const { id } = payload as { id: string; nickname: string }
      setParticipants((prev) => prev.filter((p) => p.id !== id))
    })

    client.on('message:RoleChanged', (payload) => {
      const p = payload as RoleChangedPayload
      setParticipants((prev) =>
        prev.map((part) =>
          part.id === p.user_id ? { ...part, role: p.new_role } : part,
        ),
      )
      if (p.user_id === myUserIdRef.current) {
        setMyRole(p.new_role)
      }
    })

    client.on('message:RoomClosed', () => {
      setRoomClosed(true)
      client.disconnect()
    })

    client.on('message:TimeSyncResponse', (payload) => {
      clock.handleResponse(payload as TimeSyncResponsePayload)
    })

    client.on('message:Play', (payload) => {
      playback.onPlayBroadcast(payload as PlayBroadcastPayload)
    })

    client.on('message:Pause', (payload) => {
      playback.onPauseBroadcast(payload as PauseBroadcastPayload)
    })

    client.on('message:Seek', (payload) => {
      playback.onSeekBroadcast(payload as SeekBroadcastPayload)
    })

    client.on('message:SetPlaybackRate', (payload) => {
      playback.onSetPlaybackRateBroadcast(payload as SetPlaybackRateBroadcastPayload)
    })

    client.on('message:PersonalPlay', (payload) => {
      console.log('[WS] PersonalPlay получен:', payload)
      playback.onPersonalPlayBroadcast(payload as PersonalPlayPayload)
    })

    client.on('message:ChatMessage', (payload) => {
      const msg = payload as ChatMessageBroadcastPayload
      setMessages((prev) => {
        const next = [...prev, msg]
        return next.length > 100 ? next.slice(next.length - 100) : next
      })
    })

    client.on('message:Error', (payload) => {
      const err = payload as { code: string; message: string }
      console.warn('[server Error]', err.code, err.message)
    })

    client.on('max_retries_exceeded', () => {
      setStatus('failed')
    })

    client.connect(sessionId, nickname)

    return () => {
      clock.stop()
      playback.destroy()
      client.disconnect()
    }
  }, [sessionId, nickname])

  const reconnect = useCallback(() => {
    clientRef.current?.connect(sessionId, nickname)
  }, [sessionId, nickname])

  const sendSetVideoUrl = useCallback((url: string) => {
    clientRef.current?.send({ type: 'SetVideoUrl', payload: { video_url: url } })
  }, [])

  const sendGrantAdmin = useCallback((targetUserId: string) => {
    clientRef.current?.send({ type: 'GrantAdmin', payload: { target_user_id: targetUserId } })
  }, [])

  const sendRevokeAdmin = useCallback((targetUserId: string) => {
    clientRef.current?.send({ type: 'RevokeAdmin', payload: { target_user_id: targetUserId } })
  }, [])

  const sendCloseRoom = useCallback(() => {
    clientRef.current?.send({ type: 'CloseRoom', payload: {} })
  }, [])

  const sendChat = useCallback((text: string) => {
    const trimmed = text.trim()
    if (trimmed) {
      clientRef.current?.send({ type: 'ChatMessage', payload: { text: trimmed } })
    }
  }, [])

  return {
    status,
    participants,
    myUserId,
    myRole,
    videoUrl,
    roomClosed,
    reconnect,
    sendSetVideoUrl,
    sendGrantAdmin,
    sendRevokeAdmin,
    sendCloseRoom,
    clockSync,
    playbackSync,
    messages,
    sendChat,
    isSyncing,
  }
}
