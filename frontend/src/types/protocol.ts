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

// --- Сервер → клиент ---

export interface WelcomePayload {
  session_id: string
  your_user_id: string
  video_url: string
  is_playing: boolean
  position_ms: number
  playback_rate: number
  participants: ParticipantInfo[]
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

export type ServerMessage =
  | WelcomeMessage
  | ParticipantJoinedMessage
  | ParticipantLeftMessage
  | ErrorMessage
  | TimeSyncResponseMessage

export type ClientMessage = HelloMessage | TimeSyncRequestMessage
