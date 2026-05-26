import { useState } from 'react'
import { useWebSocket } from './ws/useWebSocket'
import type { ConnectionStatus } from './ws/WSClient'
import { useClockSync, type ClockSyncState } from './sync/useClockSync'
import { usePlayback } from './playback/usePlayback'
import type { PlaybackSync } from './playback/PlaybackSync'
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

// --- Контролы воспроизведения ---

interface PlaybackControlsProps {
  sync: PlaybackSync | null
  disabled: boolean
}

function PlaybackControls({ sync, disabled }: PlaybackControlsProps) {
  const { state, play, pause, seek, setRate } = usePlayback(sync)
  const [seekInput, setSeekInput] = useState('')

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

      <div className="playback-row">
        <span className="playback-label">Видео:</span>
        <span className="video-url">{state.videoUrl || 'не задано'}</span>
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
  const { status, participants, myUserId, reconnect, clockSync, playbackSync } =
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

      <div>
        <SyncIndicator sync={sync} />
      </div>

      <PlaybackControls sync={playbackSync} disabled={!isConnected || playbackSync === null} />

      {status === 'failed' && (
        <button className="btn" onClick={reconnect}>
          Подключиться заново
        </button>
      )}

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
