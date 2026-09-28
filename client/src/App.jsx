import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, Mic, MicOff, MonitorUp, PhoneOff, Video, VideoOff } from 'lucide-react';
import { useCall } from './useCall';
import './App.css';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const makeRoomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => ALPHABET[b % ALPHABET.length]).join('');

const initials = (name) =>
  (name || 'Guest').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase()).join('') || 'G';

function useElapsed(active) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    setSeconds(0);
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
  const h = Math.floor(seconds / 3600);
  const m = String(Math.floor((seconds % 3600) / 60)).padStart(h ? 2 : 1, '0');
  const s = String(seconds % 60).padStart(2, '0');
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}

function VideoTile({ stream, name, isLocal = false, mirrored = false, videoOff = false, muted = false, connection, className = '' }) {
  const videoRef = useRef(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    setPlaying(false);
    el.srcObject = stream ?? null;
    if (stream) el.play().catch(() => {}); // autoplay can be blocked until a gesture
  }, [stream]);

  const showVideo = playing && !videoOff;
  const isConnecting = connection && connection !== 'connected';

  return (
    <figure className={`tile ${className}`}>
      <div className="tile-avatar" aria-hidden="true"><span>{initials(name)}</span></div>
      <video
        ref={videoRef}
        className={`tile-video${showVideo ? ' is-live' : ''}${mirrored ? ' is-mirrored' : ''}`}
        autoPlay
        playsInline
        muted={isLocal}
        onPlaying={() => setPlaying(true)}
      />
      {isConnecting && (
        <div className="tile-status" role="status">
          {connection === 'failed' || connection === 'disconnected' ? 'Reconnecting…' : 'Connecting…'}
        </div>
      )}
      <figcaption className="tile-name">
        {isLocal ? `${name} (You)` : name}
        {muted && <MicOff size={14} aria-label="Muted" />}
      </figcaption>
    </figure>
  );
}

function ControlButton({ label, active = false, danger = false, disabled = false, onClick, children }) {
  return (
    <button
      type="button"
      className={`ctl${active ? ' is-active' : ''}${danger ? ' is-danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active || undefined}
      title={label}
    >
      {children}
    </button>
  );
}

function JoinScreen({ initialRoom, error, busy, onJoin }) {
  const [name, setName] = useState('');
  const [roomId, setRoomId] = useState(initialRoom);
  const hasRoom = roomId.trim().length > 0;

  const submit = (e) => {
    e.preventDefault();
    onJoin(roomId.trim().toUpperCase() || makeRoomId(), name.trim() || 'Guest');
  };

  return (
    <main className="join">
      <form className="join-card" onSubmit={submit}>
        <h1>Start or join a call</h1>
        <p className="muted">Video calls in your browser. No account needed.</p>

        <label className="field">
          <span>Your name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest" autoComplete="name" disabled={busy} />
        </label>
        <label className="field">
          <span>Room code</span>
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="Leave empty to create a new room"
            autoCapitalize="characters"
            spellCheck="false"
            disabled={busy}
          />
        </label>

        {error && <p className="form-error" role="alert">{error}</p>}

        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? 'Starting camera…' : hasRoom ? 'Join call' : 'Create new call'}
        </button>
      </form>
    </main>
  );
}

function CallScreen({ call, onCopyLink }) {
  const { room, peers, localStream, isMuted, isCameraOff, isSharing, signalOnline } = call;
  const elapsed = useElapsed(true);
  const alone = peers.length === 0;
  const name = room.name;

  const localTile = (
    <VideoTile
      stream={localStream}
      name={name}
      isLocal
      mirrored={!isSharing}
      videoOff={isCameraOff && !isSharing}
      muted={isMuted}
      className={alone ? 'tile-solo' : 'tile-self'}
    />
  );

  return (
    <div className="call">
      <header className="call-bar">
        <div className="call-title">
          <strong>{room.id}</strong>
          <span className="muted">{elapsed}</span>
        </div>
        <span className="muted">{alone ? 'Only you' : `${peers.length + 1} in call`}</span>
      </header>

      {!signalOnline && <div className="banner" role="status">Connection to the server was lost. Reconnecting…</div>}

      <section className="stage" data-count={Math.min(peers.length, 9)}>
        {alone ? localTile : peers.map((p) => (
          <VideoTile key={p.id} stream={p.stream} name={p.name} connection={p.connectionState} />
        ))}
        {!alone && localTile}

        {alone && (
          <aside className="invite">
            <h2>Waiting for others</h2>
            <p className="muted">Share the link so people can join room {room.id}.</p>
            <button type="button" className="btn-primary" onClick={onCopyLink}>Copy invite link</button>
          </aside>
        )}
      </section>

      <footer className="controls">
        <ControlButton label={isMuted ? 'Unmute' : 'Mute'} active={isMuted} onClick={call.toggleMute}>
          {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
        </ControlButton>
        <ControlButton label={isCameraOff ? 'Turn camera on' : 'Turn camera off'} active={isCameraOff} onClick={call.toggleCamera}>
          {isCameraOff ? <VideoOff size={20} /> : <Video size={20} />}
        </ControlButton>
        <ControlButton label={isSharing ? 'Stop sharing' : 'Share screen'} active={isSharing} disabled={!call.canShareScreen} onClick={call.toggleScreenShare}>
          <MonitorUp size={20} />
        </ControlButton>
        <ControlButton label="Copy invite link" onClick={onCopyLink}>
          <Link2 size={20} />
        </ControlButton>
        <ControlButton label="Leave call" danger onClick={call.leave}>
          <PhoneOff size={20} />
        </ControlButton>
      </footer>
    </div>
  );
}

export default function App() {
  const call = useCall();
  const [toast, setToast] = useState('');
  const toastTimer = useRef(null);
  const initialRoom = useRef(new URLSearchParams(window.location.search).get('room') || '');

  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2500);
  }, []);

  const copyLink = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}?room=${encodeURIComponent(call.room?.id ?? '')}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Invite link copied');
    } catch {
      showToast(`Copy failed. Share room code ${call.room?.id}`);
    }
  }, [call.room, showToast]);

  // Keep the address bar shareable while in a call.
  useEffect(() => {
    if (call.status === 'in-call' && call.room) {
      window.history.replaceState(null, '', `?room=${encodeURIComponent(call.room.id)}`);
    } else if (call.status === 'idle') {
      window.history.replaceState(null, '', window.location.pathname);
    }
  }, [call.status, call.room]);

  return (
    <>
      {call.status === 'in-call' && call.room ? (
        <CallScreen call={call} onCopyLink={copyLink} />
      ) : (
        <JoinScreen initialRoom={initialRoom.current} error={call.error} busy={call.status === 'joining'} onJoin={call.join} />
      )}
      <div className={`toast${toast ? ' is-visible' : ''}`} role="status" aria-live="polite">{toast}</div>
    </>
  );
}