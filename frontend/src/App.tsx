import { useState } from 'react'
import { useWebSocket } from './ws/useWebSocket'
import type { ConnectionStatus } from './ws/WSClient'
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

// --- Экран комнаты ---

interface RoomScreenProps {
  nickname: string
  onLeave: () => void
}

function RoomScreen({ nickname, onLeave }: RoomScreenProps) {
  const { status, participants, myUserId, reconnect } = useWebSocket(SESSION_ID, nickname)

  return (
    <div className="app">
      <h1>WatchTogether</h1>
      <p className="subtitle">
        Комната: <strong>{SESSION_ID}</strong>
      </p>

      <div className="status-badge" style={{ color: STATUS_COLOR[status] }}>
        ● {STATUS_LABEL[status]}
      </div>

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
