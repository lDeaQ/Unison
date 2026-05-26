export interface ParticipantInfo {
  id: string
  nickname: string
  role: string // "owner" | "participant"
}

// --- Клиент → сервер ---

export interface HelloMessage {
  type: 'Hello'
  payload: {
    session_id: string
    nickname: string
  }
}

export interface TimeSyncRequestPayload {
  client_send_ms: number  // t0 — performance.now() в момент отправки
}

export interface TimeSyncRequestMessage {
  type: 'TimeSyncRequest'
  payload: TimeSyncRequestPayload
}

export interface PlayRequestMessage {
  type: 'Play'
  payload: { position_ms: number }
}

export interface PauseRequestMessage {
  type: 'Pause'
  payload: { position_ms: number }
}

export interface SeekRequestMessage {
  type: 'Seek'
  payload: { position_ms: number }
}

export interface SetPlaybackRateRequestMessage {
  type: 'SetPlaybackRate'
  payload: { rate: number }
}

// --- Сервер → клиент ---

export interface WelcomePayload {
  session_id: string
  your_user_id: string
  video_url: string
  is_playing: boolean
  position_ms: number
  playback_rate: number
  participants: ParticipantInfo[]
  server_time_ms: number
}

export interface WelcomeMessage {
  type: 'Welcome'
  payload: WelcomePayload
}

export interface ParticipantJoinedMessage {
  type: 'ParticipantJoined'
  payload: ParticipantInfo
}

export interface ParticipantLeftMessage {
  type: 'ParticipantLeft'
  payload: { id: string; nickname: string }
}

export interface ErrorMessage {
  type: 'Error'
  payload: { code: string; message: string }
}

export interface TimeSyncResponsePayload {
  client_send_ms: number    // эхо t0 — для сопоставления запроса с ответом
  server_receive_ms: number // t1
  server_send_ms: number    // t2
}

export interface TimeSyncResponseMessage {
  type: 'TimeSyncResponse'
  payload: TimeSyncResponsePayload
}

export interface PlayBroadcastPayload {
  position_ms: number
  server_timestamp_ms: number
  execute_at_ms: number
}

export interface PlayBroadcastMessage {
  type: 'Play'
  payload: PlayBroadcastPayload
}

export interface PauseBroadcastPayload {
  position_ms: number
  server_timestamp_ms: number
  execute_at_ms: number
}

export interface PauseBroadcastMessage {
  type: 'Pause'
  payload: PauseBroadcastPayload
}

export interface SeekBroadcastPayload {
  position_ms: number
  server_timestamp_ms: number
  execute_at_ms: number
}

export interface SeekBroadcastMessage {
  type: 'Seek'
  payload: SeekBroadcastPayload
}

export interface SetPlaybackRateBroadcastPayload {
  rate: number
  position_ms: number
  server_timestamp_ms: number
  execute_at_ms: number
}

export interface SetPlaybackRateBroadcastMessage {
  type: 'SetPlaybackRate'
  payload: SetPlaybackRateBroadcastPayload
}

export type ServerMessage =
  | WelcomeMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ErrorMessage
  | TimeSyncResponseMessage
  | PlayBroadcastMessage
  | PauseBroadcastMessage
  | SeekBroadcastMessage
  | SetPlaybackRateBroadcastMessage

export type ClientMessage =
  | HelloMessage
  | TimeSyncRequestMessage
  | PlayRequestMessage
  | PauseRequestMessage
  | SeekRequestMessage
  | SetPlaybackRateRequestMessage
