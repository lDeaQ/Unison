import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from './ws/useWebSocket'
import type { ConnectionStatus } from './ws/WSClient'
import { useClockSync, type ClockSyncState } from './sync/useClockSync'
import { usePlayback } from './playback/usePlayback'
import type { PlaybackSync } from './playback/PlaybackSync'
import { PlayerFactory } from './players/PlayerFactory'
import type { IPlayerAdapter } from './players/IPlayerAdapter'
import type { ChatMessageBroadcastPayload } from './types/protocol'
import './App.css'

const SESSION_ID = 'demo'

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: 'Отключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  reconnecting: 'Переподключение…',
  failed: 'Не удалось подключиться',
}

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  disconnected: '#888',
  connecting: '#f0a500',
  connected: '#22c55e',
  reconnecting: '#f0a500',
  failed: '#ef4444',
}

const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

function formatPosition(ms: number): string {
  const total = Math.max(0, Math.floor(ms))
  const mmm = total % 1000
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60_000) % 60
  const h = Math.floor(total / 3_600_000)
  return (
    `${String(h).padStart(2, '0')}:` +
    `${String(m).padStart(2, '0')}:` +
    `${String(s).padStart(2, '0')}.` +
    `${String(mmm).padStart(3, '0')}`
  )
}

// --- Sync-индикатор ---

function rttColor(rtt: number): string {
  if (rtt < 50) return '#22c55e'
  if (rtt < 150) return '#f0a500'
  return '#ef4444'
}

function formatSigned(n: number, digits: number): string {
  // После округления используем нормализованное значение, чтобы корректно
  // обработать случаи -0 и значения, округляющиеся в ноль.
  const rounded = Number(n.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)  // "0.0" без знака
  const s = rounded.toFixed(digits)
  return rounded > 0 ? `+${s}` : s  // отрицательное уже содержит "-"
}

function SyncIndicator({ sync }: { sync: ClockSyncState }) {
  if (!sync.isReady) {
    return <div className="sync-indicator placeholder">Синхронизация…</div>
  }
  return (
    <div className="sync-indicator">
      Sync: drift {formatSigned(sync.drift, 1)} мс ±{sync.uncertainty.toFixed(1)} мс |{' '}
      <span style={{ color: rttColor(sync.lastRtt) }}>RTT {sync.lastRtt.toFixed(1)} мс</span>
      {' | '}n={sync.measurementCount}
    </div>
  )
}

// --- Видеопанель: URL-инпут + iframe ---

interface VideoPanelProps {
  videoUrl: string
  sendSetVideoUrl: (url: string) => void
  onAdapterChange?: (adapter: IPlayerAdapter | null) => void
  isSyncing: boolean
}

function VideoPanel({ videoUrl, sendSetVideoUrl, onAdapterChange, isSyncing }: VideoPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<IPlayerAdapter | null>(null)
  // Ref для колбэка — всегда актуален, но не является зависимостью useEffect.
  // Это исключает пересоздание адаптера при каждом рендере родителя (NTP-тик и т.п.).
  const onAdapterChangeRef = useRef(onAdapterChange)
  onAdapterChangeRef.current = onAdapterChange
  const [urlInput, setUrlInput] = useState('')

  useEffect(() => {
    // Единственная зависимость — videoUrl (строка). Срабатывает только при реальной
    // смене URL, не при NTP-обновлениях или других ре-рендерах родителя.
    console.log('[VideoPanel] useEffect: videoUrl =', videoUrl || '(пусто)')
    if (!videoUrl || !containerRef.current) return

    let adapter: IPlayerAdapter | null = null
    try {
      adapter = PlayerFactory.create(videoUrl, containerRef.current)
      adapterRef.current = adapter
      onAdapterChangeRef.current?.(adapter)
    } catch (e) {
      console.error('[VideoPanel] Ошибка создания адаптера:', e)
    }

    return () => {
      adapter?.destroy()
      adapterRef.current = null
      onAdapterChangeRef.current?.(null)
    }
  }, [videoUrl])  // только строка — стабильный примитив

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (trimmed) {
      sendSetVideoUrl(trimmed)
      setUrlInput('')
    }
  }

  return (
    <div className="video-panel">
      <form className="url-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="input"
          placeholder="https://rutube.ru/video/..."
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
        />
        <button type="submit" className="btn">
          Загрузить
        </button>
      </form>
      {videoUrl ? (
        <div style={{ position: 'relative', marginTop: 8 }}>
          <div
            ref={containerRef}
            className="player-container"
            style={{ width: '100%', aspectRatio: '16/9', background: '#000' }}
          />
          {isSyncing && (
            <div style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.72)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#fff',
              fontSize: '1.1rem',
              letterSpacing: '0.02em',
            }}>
              Синхронизация…
            </div>
          )}
        </div>
      ) : (
        <div className="player-placeholder">
          Введите ссылку на видео выше
        </div>
      )}
    </div>
  )
}

// --- Контролы воспроизведения ---

interface PlaybackControlsProps {
  sync: PlaybackSync | null
  disabled: boolean
  videoUrl: string
}

function PlaybackControls({ sync, disabled, videoUrl }: PlaybackControlsProps) {
  const { state, play, pause, seek, setRate } = usePlayback(sync)
  const [seekInput, setSeekInput] = useState('')
  const platform = videoUrl ? PlayerFactory.detect(videoUrl) : null

  const seekMs = parseInt(seekInput, 10)
  const seekValid = seekInput !== '' && !isNaN(seekMs) && seekMs >= 0

  const handleSeek = () => {
    if (!seekValid) return
    seek(seekMs)
    setSeekInput('')
  }

  return (
    <div className="playback-panel">
      <h2>Воспроизведение</h2>

      <div className="playback-row">
        <button
          className="btn playback-toggle"
          onClick={state.isPlaying ? pause : play}
          disabled={disabled}
        >
          {state.isPlaying ? '⏸ Pause' : '▶ Play'}
        </button>
        <code className="position-display">{formatPosition(state.positionMs)}</code>
        <button
          className="btn btn-secondary"
          style={{ marginTop: 0 }}
          onClick={() => seek(state.positionMs)}
          disabled={disabled}
          title="Отправить всем участникам команду перемотки на текущую позицию"
        >
          ⟳ Синхронизировать
        </button>
      </div>

      <div className="playback-row">
        <span className="playback-label">Seek (мс):</span>
        <input
          type="number"
          className="input input-sm"
          placeholder="0"
          value={seekInput}
          min={0}
          disabled={disabled}
          onChange={(e) => setSeekInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSeek()}
        />
        <button
          className="btn btn-sm"
          onClick={handleSeek}
          disabled={disabled || !seekValid}
        >
          Перейти
        </button>
      </div>

      <div className="playback-row">
        <span className="playback-label">Скорость:</span>
        <div className="rate-buttons">
          {PLAYBACK_RATES.map((r) => (
            <button
              key={r}
              className={`btn btn-rate${state.playbackRate === r ? ' btn-rate-active' : ''}`}
              onClick={() => setRate(r)}
              disabled={disabled}
            >
              {r}x
            </button>
          ))}
        </div>
      </div>

      {platform === 'rutube' && (
        <div className="playback-row">
          <span className="rate-warning">
            ⚠ RuTube: изменение скорости не поддерживается embed API
          </span>
        </div>
      )}
    </div>
  )
}

// --- Чат ---

interface ChatPanelProps {
  messages: ChatMessageBroadcastPayload[]
  sendChat: (text: string) => void
  myUserId: string | null
  disabled: boolean
}

function ChatPanel({ messages, sendChat, myUserId, disabled }: ChatPanelProps) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed) return
    sendChat(trimmed)
    setInput('')
  }, [input, sendChat])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSend()
    }
  }

  const formatTime = (ms: number) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="chat-panel">
      <h2>Чат</h2>
      <div className="chat-messages">
        {messages.length === 0 ? (
          <p className="chat-empty">Нет сообщений</p>
        ) : (
          messages.map((msg) => {
            const isOwn = msg.user_id === myUserId
            return (
              <div
                key={`${msg.user_id}-${msg.timestamp_ms}`}
                className={`chat-msg ${isOwn ? 'chat-msg-own' : 'chat-msg-other'}`}
              >
                {!isOwn && <span className="chat-nickname">{msg.nickname}</span>}
                <span className="chat-text">{msg.text}</span>
                <span className="chat-time">{formatTime(msg.timestamp_ms)}</span>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input
          className="input chat-input"
          type="text"
          placeholder="Написать сообщение…"
          value={input}
          maxLength={500}
          disabled={disabled}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <button
          className="btn btn-sm"
          onClick={handleSend}
          disabled={disabled || !input.trim()}
        >
          Отправить
        </button>
      </div>
    </div>
  )
}

// --- Экран комнаты ---

interface RoomScreenProps {
  nickname: string
  onLeave: () => void
}

function RoomScreen({ nickname, onLeave }: RoomScreenProps) {
  const { status, participants, myUserId, videoUrl, reconnect, sendSetVideoUrl, clockSync, playbackSync, messages, sendChat, isSyncing } =
    useWebSocket(SESSION_ID, nickname)
  const sync = useClockSync(clockSync)
  const isConnected = status === 'connected'

  return (
    <div className="app">
      <h1>WatchTogether</h1>
      <p className="subtitle">
        Комната: <strong>{SESSION_ID}</strong>
      </p>

      <div className="status-badge" style={{ color: STATUS_COLOR[status] }}>
        ● {STATUS_LABEL[status]}
      </div>

      <VideoPanel
        videoUrl={videoUrl}
        sendSetVideoUrl={sendSetVideoUrl}
        onAdapterChange={(adapter) => playbackSync?.setAdapter(adapter)}
        isSyncing={isSyncing}
      />

      <div>
        <SyncIndicator sync={sync} />
      </div>

      <PlaybackControls
        sync={playbackSync}
        disabled={!isConnected || playbackSync === null}
        videoUrl={videoUrl}
      />

      {status === 'failed' && (
        <button className="btn" onClick={reconnect}>
          Подключиться заново
        </button>
      )}

      <ChatPanel
        messages={messages}
        sendChat={sendChat}
        myUserId={myUserId}
        disabled={!isConnected}
      />

      <div className="participants">
        <h2>Участники ({participants.length})</h2>
        {participants.length === 0 ? (
          <p className="empty">Нет участников</p>
        ) : (
          <ul className="participant-list">
            {participants.map((p) => (
              <li key={p.id} className="participant-item">
                <span className="participant-name">{p.nickname}</span>
                {p.id === myUserId && <span className="you"> (вы)</span>}
                <span className="role">{p.role === 'owner' ? ' — владелец' : ' — участник'}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <button className="btn btn-secondary" onClick={onLeave}>
        Выйти из комнаты
      </button>
    </div>
  )
}

// --- Экран входа ---

interface JoinScreenProps {
  onJoin: (nickname: string) => void
}

function JoinScreen({ onJoin }: JoinScreenProps) {
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = nickname.trim()
    if (!trimmed) {
      setError('Введите никнейм')
      return
    }
    if (trimmed.length > 32) {
      setError('Никнейм не должен превышать 32 символа')
      return
    }
    onJoin(trimmed)
  }

  return (
    <div className="app">
      <h1>WatchTogether</h1>
      <p className="subtitle">Синхронное воспроизведение мультимедиа</p>

      <form className="join-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="input"
          placeholder="Ваш никнейм"
          value={nickname}
          maxLength={32}
          autoFocus
          onChange={(e) => {
            setNickname(e.target.value)
            setError('')
          }}
        />
        {error && <p className="error">{error}</p>}
        <button type="submit" className="btn">
          Войти в комнату
        </button>
      </form>
    </div>
  )
}

// --- Корень ---

export default function App() {
  const [joined, setJoined] = useState(false)
  const [nickname, setNickname] = useState('')

  const handleJoin = (nick: string) => {
    setNickname(nick)
    setJoined(true)
  }

  if (joined) {
    return <RoomScreen nickname={nickname} onLeave={() => setJoined(false)} />
  }

  return <JoinScreen onJoin={handleJoin} />
}
