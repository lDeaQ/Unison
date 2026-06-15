import { useState, useEffect, useRef, useCallback } from 'react'
import { useWebSocket } from './ws/useWebSocket'
import type { ConnectionStatus } from './ws/WSClient'
import { useClockSync, type ClockSyncState } from './sync/useClockSync'
import { usePlayback } from './playback/usePlayback'
import type { PlaybackSync } from './playback/PlaybackSync'
import { PlayerFactory } from './players/PlayerFactory'
import type { IPlayerAdapter } from './players/IPlayerAdapter'
import type { ChatMessageBroadcastPayload, ParticipantInfo, Role } from './types/protocol'
import './App.css'

const SESSION_ID = 'demo'
const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: 'Отключено',
  connecting: 'Подключение…',
  connected: 'Подключено',
  reconnecting: 'Переподключение…',
  failed: 'Ошибка',
}

const STATUS_COLOR: Record<ConnectionStatus, string> = {
  disconnected: '#9a9a9a',
  connecting: '#f0b429',
  connected: '#22c55e',
  reconnecting: '#f0b429',
  failed: '#ef4444',
}

function formatMMSS(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseMMSS(s: string): number | null {
  const match = /^(\d+):(\d{2})$/.exec(s.trim())
  if (!match) return null
  const mins = parseInt(match[1], 10)
  const secs = parseInt(match[2], 10)
  if (secs >= 60) return null
  return (mins * 60 + secs) * 1000
}

function rttColor(rtt: number): string {
  if (rtt < 50) return '#22c55e'
  if (rtt < 150) return '#f0b429'
  return '#ef4444'
}

function formatSigned(n: number, digits: number): string {
  const rounded = Number(n.toFixed(digits))
  if (rounded === 0) return (0).toFixed(digits)
  const s = rounded.toFixed(digits)
  return rounded > 0 ? `+${s}` : s
}

// --- SVG иконки ---

function IconPlay() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
      <polygon points="4,2 16,9 4,16" />
    </svg>
  )
}

function IconPause() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor">
      <rect x="3" y="2" width="4" height="14" rx="1" />
      <rect x="11" y="2" width="4" height="14" rx="1" />
    </svg>
  )
}

function IconCrown({ color }: { color: string }) {
  return (
    <svg width="13" height="11" viewBox="0 0 13 11" fill="none">
      <path
        d="M0.5 9.5h12M0.5 9.5L2 4L5 6.5L6.5 1L8 6.5L11 4L12.5 9.5H0.5z"
        stroke={color}
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
        fill={color}
        fillOpacity="0.25"
      />
    </svg>
  )
}

function RoleBadge({ role }: { role: string }) {
  if (role === 'creator') return <IconCrown color="#ef4444" />
  if (role === 'admin') return <IconCrown color="#f0b429" />
  return null
}

function roleLabel(role: string): string {
  if (role === 'creator') return 'создатель'
  if (role === 'admin') return 'администратор'
  return 'участник'
}

function IconVolume() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" opacity="0.4">
      <path d="M2 5.5h2.5L8 2v12L4.5 10.5H2V5.5z" />
      <path d="M10.5 4.5c1.5 1 1.5 6 0 7" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
      <path d="M12.5 2.5c2.5 2 2.5 9 0 11" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
    </svg>
  )
}

function IconChevronLeft() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M9 3L5 7.5L9 12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconChevronRight() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M6 3l4 4.5-4 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconChevronDown() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M3 5.5l4.5 4 4.5-4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function IconChevronUp() {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
      <path d="M3 9.5l4.5-4 4.5 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// --- Sync-строка ---

function SyncLine({ sync }: { sync: ClockSyncState }) {
  if (!sync.isReady) {
    return <span className="sync-line placeholder">синхронизация…</span>
  }
  return (
    <span className="sync-line">
      drift {formatSigned(sync.drift, 1)} мс ±{sync.uncertainty.toFixed(1)} |{' '}
      <span style={{ color: rttColor(sync.lastRtt) }}>RTT {sync.lastRtt.toFixed(0)} мс</span>
      {' | '}n={sync.measurementCount}
    </span>
  )
}

// --- Прогресс-бар ---

interface ProgressBarProps {
  positionMs: number
  durationMs: number
  onSeek: (ms: number) => void
  disabled: boolean
}

function ProgressBar({ positionMs, durationMs, onSeek, disabled }: ProgressBarProps) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const isDragging = useRef(false)

  const pct = durationMs > 0 ? Math.min(100, (positionMs / durationMs) * 100) : 0

  // rect берём с wrapperRef — корректно при drag за пределы элемента
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = wrapperRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const seekMs = ratio * durationMs
      console.log('[ProgressBar] seek to ms:', seekMs, '| ratio:', ratio.toFixed(3), '| durationMs:', durationMs)
      onSeek(seekMs)
    },
    [durationMs, onSeek],
  )

  const handleMouseDown = (e: React.MouseEvent) => {
    if (disabled || durationMs === 0) {
      console.log('[ProgressBar] mousedown blocked — disabled:', disabled, 'durationMs:', durationMs)
      return
    }
    e.preventDefault()
    isDragging.current = true
    seekFromClientX(e.clientX)

    const onMove = (me: MouseEvent) => { if (isDragging.current) seekFromClientX(me.clientX) }
    const onUp = (_me: MouseEvent) => {
      isDragging.current = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  return (
    <div
      ref={wrapperRef}
      className={`progress-wrapper${disabled || durationMs === 0 ? ' disabled' : ''}`}
      onMouseDown={handleMouseDown}
    >
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

// --- Панель участников (левая) ---

interface ParticipantsPanelProps {
  participants: ParticipantInfo[]
  myUserId: string | null
  myRole: Role | null
  open: boolean
  onToggle: () => void
  sendGrantAdmin: (id: string) => void
  sendRevokeAdmin: (id: string) => void
  sendCloseRoom: () => void
}

function ParticipantsPanel({
  participants,
  myUserId,
  myRole,
  open,
  onToggle,
  sendGrantAdmin,
  sendRevokeAdmin,
  sendCloseRoom,
}: ParticipantsPanelProps) {
  const isCreator = myRole === 'creator'

  const handleCloseRoom = () => {
    if (window.confirm('Закрыть комнату? Все участники будут отключены.')) {
      sendCloseRoom()
    }
  }

  return (
    <aside className={`left-panel${open ? '' : ' collapsed'}`}>
      <div className="panel-header">
        {open && (
          <span className="panel-title">Участники ({participants.length})</span>
        )}
        <button className="icon-btn" onClick={onToggle} title={open ? 'Свернуть' : 'Развернуть'}>
          {open ? <IconChevronLeft /> : <IconChevronRight />}
        </button>
      </div>

      {open && (
        <>
          <ul className="participant-list">
            {participants.length === 0 ? (
              <li className="participant-empty">Нет участников</li>
            ) : (
              participants.map((p) => (
                <li key={p.id} className="participant-item">
                  <span className="participant-icon">
                    {p.role === 'participant'
                      ? <span className="participant-dot" />
                      : <RoleBadge role={p.role} />}
                  </span>
                  <span className="participant-info">
                    <span className="participant-name">
                      {p.nickname}
                      {p.id === myUserId && <span className="you-tag"> (вы)</span>}
                    </span>
                    <span className="participant-role">{roleLabel(p.role)}</span>
                  </span>
                  {isCreator && p.id !== myUserId && (
                    p.role === 'admin' ? (
                      <button
                        className="role-action-btn revoke"
                        title="Снять роль admin"
                        onClick={() => sendRevokeAdmin(p.id)}
                      >
                        − admin
                      </button>
                    ) : (
                      <button
                        className="role-action-btn"
                        title="Назначить admin"
                        onClick={() => sendGrantAdmin(p.id)}
                      >
                        + admin
                      </button>
                    )
                  )}
                </li>
              ))
            )}
          </ul>

          {isCreator && (
            <div className="panel-footer">
              <button className="close-room-btn" onClick={handleCloseRoom}>
                Закрыть комнату
              </button>
            </div>
          )}
        </>
      )}
    </aside>
  )
}

// --- Панель управления воспроизведением ---

interface PlayerControlsProps {
  sync: PlaybackSync | null
  disabled: boolean
  videoUrl: string
  durationMs: number
  clockSync: ClockSyncState
}

function PlayerControls({ sync, disabled, videoUrl, durationMs, clockSync }: PlayerControlsProps) {
  const { state, play, pause, seek, setRate } = usePlayback(sync)
  const [seekInput, setSeekInput] = useState('')
  const [rateOpen, setRateOpen] = useState(false)
  const platform = videoUrl ? PlayerFactory.detect(videoUrl) : null

  const seekMs = parseMMSS(seekInput)

  const handleSeekSubmit = () => {
    if (seekMs === null) return
    seek(seekMs)
    setSeekInput('')
  }

  return (
    <div className="controls-area">
      {/* Строка: кнопка + прогресс + время + громкость + скорость */}
      <div className="controls-bar">
        <button
          className={`play-btn${state.isPlaying ? ' playing' : ''}`}
          onClick={state.isPlaying ? pause : play}
          disabled={disabled}
          title={state.isPlaying ? 'Пауза' : 'Воспроизвести'}
        >
          {state.isPlaying ? <IconPause /> : <IconPlay />}
        </button>

        <span className="time-label">{formatMMSS(state.positionMs)}</span>

        <ProgressBar
          positionMs={state.positionMs}
          durationMs={durationMs}
          onSeek={seek}
          disabled={disabled}
        />

        <span className="time-label muted">{formatMMSS(durationMs)}</span>

        <span className="volume-icon"><IconVolume /></span>

        <div className="rate-selector">
          <button
            className="rate-btn"
            onClick={() => setRateOpen((v) => !v)}
            disabled={disabled || platform === 'rutube'}
            title={platform === 'rutube' ? 'RuTube не поддерживает изменение скорости' : undefined}
          >
            {state.playbackRate}x
          </button>
          {rateOpen && (
            <div className="rate-dropdown">
              {PLAYBACK_RATES.map((r) => (
                <button
                  key={r}
                  className={`rate-option${state.playbackRate === r ? ' active' : ''}`}
                  onClick={() => { setRate(r); setRateOpen(false) }}
                  disabled={disabled || platform === 'rutube'}
                >
                  {r}x
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Кнопка синхронизации для всех */}
      <button
        className="sync-all-btn"
        onClick={() => seek(state.positionMs)}
        disabled={disabled}
      >
        Синхронизация для всех
      </button>

      {/* Seek по MM:SS + sync-индикатор */}
      <div className="seek-sync-row">
        <div className="seek-group">
          <input
            type="text"
            className="seek-input"
            placeholder="MM:SS"
            value={seekInput}
            onChange={(e) => setSeekInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSeekSubmit()}
            disabled={disabled}
          />
          <button
            className="seek-go-btn"
            onClick={handleSeekSubmit}
            disabled={disabled || seekMs === null}
          >
            Перейти
          </button>
        </div>

        {platform === 'rutube' && (
          <span className="rate-warning">RuTube: скорость не поддерживается</span>
        )}

        <SyncLine sync={clockSync} />
      </div>
    </div>
  )
}

// --- Видеопанель ---

interface VideoPanelProps {
  videoUrl: string
  sendSetVideoUrl: (url: string) => void
  onAdapterChange?: (adapter: IPlayerAdapter | null) => void
  isSyncing: boolean
  isController: boolean
}

function VideoPanel({ videoUrl, sendSetVideoUrl, onAdapterChange, isSyncing, isController }: VideoPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const adapterRef = useRef<IPlayerAdapter | null>(null)
  const onAdapterChangeRef = useRef(onAdapterChange)
  onAdapterChangeRef.current = onAdapterChange
  const [urlInput, setUrlInput] = useState('')
  const [urlError, setUrlError] = useState('')

  useEffect(() => {
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
  }, [videoUrl])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = urlInput.trim()
    if (!trimmed) return
    if (!PlayerFactory.detect(trimmed)) {
      setUrlError('Неподдерживаемая платформа')
      return
    }
    setUrlError('')
    sendSetVideoUrl(trimmed)
    setUrlInput('')
  }

  return (
    <div className="video-panel">
      <form className="url-form" onSubmit={handleSubmit}>
        <input
          type="text"
          className="url-input"
          placeholder="https://rutube.ru/video/..."
          value={urlInput}
          disabled={!isController}
          onChange={(e) => { setUrlInput(e.target.value); setUrlError('') }}
        />
        <button type="submit" className="url-btn" disabled={!isController}>Загрузить</button>
      </form>
      {urlError && <span className="url-error">{urlError}</span>}

      {videoUrl ? (
        <div className="player-wrapper">
          <div ref={containerRef} className="player-container" />
          {isSyncing && (
            <div className="syncing-overlay">Синхронизация…</div>
          )}
        </div>
      ) : (
        <div className="player-placeholder">
          Введите ссылку на видео
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
  open: boolean
  onToggle: () => void
}

function ChatPanel({ messages, sendChat, myUserId, disabled, open, onToggle }: ChatPanelProps) {
  const [input, setInput] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, open])

  const handleSend = useCallback(() => {
    const trimmed = input.trim()
    if (!trimmed) return
    sendChat(trimmed)
    setInput('')
  }, [input, sendChat])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); handleSend() }
  }

  const formatTime = (ms: number) => {
    const d = new Date(ms)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  return (
    <div className="chat-panel">
      <div className="panel-header">
        <span className="panel-title">Чат</span>
        <button className="icon-btn" onClick={onToggle}>
          {open ? <IconChevronUp /> : <IconChevronDown />}
        </button>
      </div>

      {open && (
        <>
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
                    {!isOwn && <span className="chat-nick">{msg.nickname}</span>}
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
              className="chat-input"
              type="text"
              placeholder="Написать сообщение…"
              value={input}
              maxLength={500}
              disabled={disabled}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button
              className="chat-send-btn"
              onClick={handleSend}
              disabled={disabled || !input.trim()}
            >
              Отправить
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// --- Экран комнаты ---

function RoomScreen({ nickname, onLeave }: { nickname: string; onLeave: () => void }) {
  const {
    status, participants, myUserId, myRole, videoUrl, roomClosed,
    reconnect, sendSetVideoUrl, sendGrantAdmin, sendRevokeAdmin, sendCloseRoom,
    clockSync, playbackSync, messages, sendChat, isSyncing,
  } = useWebSocket(SESSION_ID, nickname)
  const sync = useClockSync(clockSync)
  const isConnected = status === 'connected'
  const isController = myRole === 'creator' || myRole === 'admin'
  const controlsDisabled = !isConnected || playbackSync === null || !isController

  const [leftOpen, setLeftOpen] = useState(true)
  const [chatOpen, setChatOpen] = useState(true)
  const [durationMs, setDurationMs] = useState(0)

  const handleAdapterChange = useCallback(
    (adapter: IPlayerAdapter | null) => {
      playbackSync?.setAdapter(adapter)
      setDurationMs(0)
      if (!adapter) return

      const onTimeUpdate = () => {
        const d = (adapter as unknown as { getDurationMs?: () => number }).getDurationMs?.() ?? 0
        setDurationMs(d)
      }
      adapter.on('timeupdate', onTimeUpdate)
      // listeners очищаются в adapter.destroy() — отписка не нужна
    },
    [playbackSync],
  )

  return (
    <div className="room-layout">
      <header className="app-header">
        <span className="app-logo">Unison</span>
        <div className="header-right">
          <span className="status-dot" style={{ background: STATUS_COLOR[status] }} />
          <span className="status-text">{STATUS_LABEL[status]}</span>
          {status === 'failed' && (
            <button className="small-btn" onClick={reconnect}>Переподключиться</button>
          )}
          <button className="small-btn secondary" onClick={onLeave}>Выйти</button>
        </div>
      </header>

      <div className="room-body">
        <ParticipantsPanel
          participants={participants}
          myUserId={myUserId}
          myRole={myRole}
          open={leftOpen}
          onToggle={() => setLeftOpen((v) => !v)}
          sendGrantAdmin={sendGrantAdmin}
          sendRevokeAdmin={sendRevokeAdmin}
          sendCloseRoom={sendCloseRoom}
        />

        <main className="center-col">
          <VideoPanel
            videoUrl={videoUrl}
            sendSetVideoUrl={sendSetVideoUrl}
            onAdapterChange={handleAdapterChange}
            isSyncing={isSyncing}
            isController={isController}
          />
          <PlayerControls
            sync={playbackSync}
            disabled={controlsDisabled}
            videoUrl={videoUrl}
            durationMs={durationMs}
            clockSync={sync}
          />
          <ChatPanel
            messages={messages}
            sendChat={sendChat}
            myUserId={myUserId}
            disabled={!isConnected}
            open={chatOpen}
            onToggle={() => setChatOpen((v) => !v)}
          />
        </main>
      </div>

      {roomClosed && (
        <div className="room-closed-overlay">
          <div className="room-closed-card">
            <p className="room-closed-title">Комната закрыта создателем</p>
            <button className="join-btn" onClick={onLeave}>На главную</button>
          </div>
        </div>
      )}
    </div>
  )
}

// --- Экран входа ---

function JoinScreen({ onJoin }: { onJoin: (nickname: string) => void }) {
  const [nickname, setNickname] = useState('')
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const trimmed = nickname.trim()
    if (!trimmed) { setError('Введите никнейм'); return }
    if (trimmed.length > 32) { setError('Максимум 32 символа'); return }
    onJoin(trimmed)
  }

  return (
    <div className="join-screen">
      <div className="join-card">
        <h1 className="join-logo">Unison</h1>
        <p className="join-subtitle">Синхронное воспроизведение медиа</p>
        <form className="join-form" onSubmit={handleSubmit}>
          <input
            type="text"
            className="join-input"
            placeholder="Ваш никнейм"
            value={nickname}
            maxLength={32}
            autoFocus
            onChange={(e) => { setNickname(e.target.value); setError('') }}
          />
          {error && <p className="join-error">{error}</p>}
          <button type="submit" className="join-btn">Войти в комнату</button>
        </form>
      </div>
    </div>
  )
}

// --- Корень ---

export default function App() {
  const [joined, setJoined] = useState(false)
  const [nickname, setNickname] = useState('')

  if (joined) {
    return <RoomScreen nickname={nickname} onLeave={() => setJoined(false)} />
  }
  return <JoinScreen onJoin={(nick) => { setNickname(nick); setJoined(true) }} />
}
