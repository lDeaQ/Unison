import type { ClientMessage, ServerMessage } from '../types/protocol'

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'failed'

const MAX_RECONNECT_ATTEMPTS = 8
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

export class WSClient {
  private ws: WebSocket | null = null
  private status: ConnectionStatus = 'disconnected'
  private reconnectAttempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private sessionId: string | null = null
  private nickname: string | null = null
  private deliberateClose = false
  private lastErrorCode: string | null = null
  private listeners: Map<string, Set<(...args: unknown[]) => void>> = new Map()

  connect(sessionId: string, nickname: string): void {
    this.sessionId = sessionId
    this.nickname = nickname
    this.deliberateClose = false
    this.reconnectAttempt = 0
    this.clearReconnectTimer()
    this.openConnection()
  }

  disconnect(): void {
    this.deliberateClose = true
    this.clearReconnectTimer()
    this.ws?.close(1000)
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    } else {
      console.warn('[WSClient] Попытка отправки при закрытом соединении:', message.type)
    }
  }

  on(event: string, cb: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set())
    }
    this.listeners.get(event)!.add(cb)
  }

  off(event: string, cb: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(cb)
  }

  getStatus(): ConnectionStatus {
    return this.status
  }

  private openConnection(): void {
    this.lastErrorCode = null
    this.setStatus('connecting')

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsHost = window.location.hostname
    const wsPort = window.location.protocol === 'https:' ? '' : ':8000'
    const base = import.meta.env.VITE_WS_URL ?? `${wsProtocol}//${wsHost}${wsPort}`
    const url = `${base}/ws/${this.sessionId}`
    this.ws = new WebSocket(url)

    this.ws.onopen = () => this.handleOpen()
    this.ws.onmessage = (event) => this.handleMessage(event)
    this.ws.onclose = (event) => this.handleClose(event)
    this.ws.onerror = (event) => this.handleError(event)
  }

  private handleOpen(): void {
    // 'connected' устанавливается в onopen
    this.reconnectAttempt = 0
    this.setStatus('connected')
    this.send({
      type: 'Hello',
      payload: {
        session_id: this.sessionId!,
        nickname: this.nickname!,
      },
    })
  }

  private handleMessage(event: MessageEvent): void {
    let msg: ServerMessage
    try {
      msg = JSON.parse(event.data as string) as ServerMessage
    } catch {
      console.error('[WSClient] Ошибка разбора JSON:', event.data)
      return
    }
    if (msg.type === 'Error') {
      this.lastErrorCode = (msg.payload as { code: string }).code
    }
    this.emit(`message:${msg.type}`, msg.payload)
  }

  private handleClose(event: CloseEvent): void {
    const errorCode = this.lastErrorCode
    this.lastErrorCode = null

    if (this.deliberateClose || event.code === 1000) {
      this.setStatus('disconnected')
      return
    }
    if (errorCode === 'NICKNAME_TAKEN') {
      this.setStatus('failed')
      this.emit('nickname_taken')
      return
    }
    this.scheduleReconnect()
  }

  private handleError(event: Event): void {
    console.error('[WSClient] Ошибка WebSocket:', event)
    this.emit('error', event)
    // Закрытие придёт через onclose — переподключение запустится там
  }

  private scheduleReconnect(): void {
    this.reconnectAttempt++

    if (this.reconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
      this.setStatus('failed')
      this.emit('max_retries_exceeded')
      return
    }

    // exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s
    const delay = Math.min(
      BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
      MAX_DELAY_MS,
    )

    this.setStatus('reconnecting')
    this.emit('reconnect_scheduled', {
      attempt: this.reconnectAttempt,
      delay_ms: delay,
    })

    this.reconnectTimer = setTimeout(() => this.openConnection(), delay)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status
    this.emit('status_change', status)
  }

  private emit(event: string, ...args: unknown[]): void {
    this.listeners.get(event)?.forEach((cb) => cb(...args))
  }
}
