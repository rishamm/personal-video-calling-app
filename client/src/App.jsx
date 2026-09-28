import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_SERVER || 'http://localhost:3001';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// 🟢 FIX 1: Dedicated React component to prevent the video from flashing black
const RemoteVideo = ({ stream, name }) => {
  const videoRef = useRef(null);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="video-card remote">
      <video ref={videoRef} autoPlay playsInline />
      <div className="video-tag">{name || 'Guest'}</div>
    </div>
  );
};

function App() {
  const [name, setName] = useState('Guest');
  const [roomId, setRoomId] = useState(generateRoomId());
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  const socketRef = useRef(null);
  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const negotiationLockRef = useRef({});
  const pendingRemoteOffersRef = useRef({});
  const pendingIceCandidatesRef = useRef({});

  const attachLocalPreview = (stream) => {
    if (!localVideoRef.current || !stream) return;
    localVideoRef.current.srcObject = stream;
    localVideoRef.current.muted = true;
    localVideoRef.current.playsInline = true;
    localVideoRef.current.autoplay = true;
  };

  const closePeerConnection = (userId) => {
    console.log(`[WebRTC] Closing connection for ${userId}`);
    const pc = peerConnectionsRef.current[userId];
    if (!pc) return;

    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();

    delete peerConnectionsRef.current[userId];
    delete negotiationLockRef.current[userId];
    delete pendingRemoteOffersRef.current[userId];
    delete pendingIceCandidatesRef.current[userId];
  };

  const createPeerConnection = (userId) => {
    if (peerConnectionsRef.current[userId]) {
      return peerConnectionsRef.current[userId];
    }

    console.log(`[WebRTC] Creating new PeerConnection for ${userId}`);
    const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
    const peerConnection = new RTCPeerConnection(configuration);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStreamRef.current);
      });
    }

    // 🟢 FIX 2: Ensure ICE Candidates are being broadcasted
    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        console.log(`[WebRTC] Generated ICE candidate, sending to ${userId}`);
        socketRef.current.emit('ice-candidate', { to: userId, candidate: event.candidate });
      }
    };

    peerConnection.ontrack = (event) => {
      console.log(`[WebRTC] ✅ Received remote track from ${userId}`);
      const [remoteStream] = event.streams;
      if (remoteStream) {
        setRemoteStreams((prev) => ({ ...prev, [userId]: remoteStream }));
      }
    };

    peerConnection.onconnectionstatechange = () => {
      console.log(`[WebRTC] Connection state with ${userId}: ${peerConnection.connectionState}`);
      if (
        peerConnection.connectionState === 'failed' ||
        peerConnection.connectionState === 'disconnected' ||
        peerConnection.connectionState === 'closed'
      ) {
        closePeerConnection(userId);
      }
    };

    peerConnectionsRef.current[userId] = peerConnection;
    return peerConnection;
  };

  const flushPendingIceCandidates = async (userId) => {
    const candidates = pendingIceCandidatesRef.current[userId] || [];
    if (candidates.length === 0) return;

    const peerConnection = peerConnectionsRef.current[userId];
    if (!peerConnection) return;

    const pending = [...candidates];
    delete pendingIceCandidatesRef.current[userId];

    for (const candidate of pending) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[WebRTC] Applied queued ICE candidate from ${userId}`);
      } catch (err) {
        console.warn('[WebRTC] Failed to add queued ICE candidate:', err);
      }
    }
  };

  const flushPendingOffer = async (userId) => {
    const pendingOffer = pendingRemoteOffersRef.current[userId];
    if (!pendingOffer) return;
    delete pendingRemoteOffersRef.current[userId];

    const peerConnection = createPeerConnection(userId);

    if (peerConnection.signalingState !== 'stable') {
      pendingRemoteOffersRef.current[userId] = pendingOffer;
      return;
    }

    try {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingOffer));
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      socketRef.current.emit('answer', { to: userId, answer });
      await flushPendingIceCandidates(userId);
    } catch (err) {
      console.error('[WebRTC] Failed to flush pending offer:', err);
    }
  };

  const connectToUser = async (userId) => {
    if (!localStreamRef.current || !userId || !socketRef.current) return;
    const peerConnection = createPeerConnection(userId);

    if (negotiationLockRef.current[userId] || peerConnection.signalingState !== 'stable') return;
    negotiationLockRef.current[userId] = true;

    try {
      console.log(`[WebRTC] Creating offer for ${userId}`);
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socketRef.current.emit('offer', { to: userId, offer });
      await flushPendingIceCandidates(userId);
    } catch (err) {
      console.error('[WebRTC] Failed to create offer:', err);
      delete negotiationLockRef.current[userId];
    }
  };

  async function getLocalStream() {
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
      const msg = 'WebRTC blocks the camera on HTTP. You must use HTTPS or localhost.';
      setError(msg);
      alert(msg);
      return null;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('Browser does not support camera/mic access.');
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      localStreamRef.current = stream;
      attachLocalPreview(stream);
      return stream;
    } catch (err) {
      console.error('[WebRTC] Media access failed:', err);
      setError('Camera/Mic access denied. Check your browser permissions.');
      return null;
    }
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, { transports: ['websocket'] });
    socketRef.current = socket;

    socket.on('connect', () => console.log('[Socket] Connected to signaling server'));

    socket.on('current-users', (users) => {
      setParticipants(users);
      users.forEach((user) => connectToUser(user.id));
    });

    socket.on('user-joined', (user) => {
      setParticipants((prev) => (prev.some((p) => p.id === user.id) ? prev : [...prev, user]));
    });

    socket.on('user-left', (userId) => {
      setParticipants((prev) => prev.filter((p) => p.id !== userId));
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      closePeerConnection(userId);
    });

    socket.on('offer', async ({ from, offer }) => {
      console.log(`[Socket] Received offer from ${from}`);
      const peerConnection = createPeerConnection(from);

      if (peerConnection.signalingState !== 'stable') {
        pendingRemoteOffersRef.current[from] = offer;
        return;
      }

      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        socket.emit('answer', { to: from, answer });
        await flushPendingIceCandidates(from);
      } catch (err) {
        console.error('[WebRTC] Error handling offer:', err);
      }
    });

    socket.on('answer', async ({ from, answer }) => {
      console.log(`[Socket] Received answer from ${from}`);
      const peerConnection = peerConnectionsRef.current[from];
      if (!peerConnection || peerConnection.signalingState !== 'have-local-offer') return;

      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        delete negotiationLockRef.current[from];
        await flushPendingIceCandidates(from);
        await flushPendingOffer(from);
      } catch (err) {
        console.error('[WebRTC] Error handling answer:', err);
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      console.log(`[Socket] ⚡ Received ICE candidate from ${from}`);
      const peerConnection = peerConnectionsRef.current[from];

      if (!peerConnection || !peerConnection.remoteDescription) {
        if (!pendingIceCandidatesRef.current[from]) pendingIceCandidatesRef.current[from] = [];
        pendingIceCandidatesRef.current[from].push(candidate);
        return;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        console.log(`[WebRTC] ⚡ Successfully added ICE candidate from ${from}`);
      } catch (err) {
        console.warn('[WebRTC] Failed to add ICE candidate:', err);
      }
    });

    return () => {
      socket.disconnect();
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((track) => track.stop());
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    };
  }, []);

  async function joinRoom() {
    if (!roomId.trim()) return setError('Room name is required.');

    const stream = await getLocalStream();
    if (!stream) return;

    setJoined(true);
    setError('');
    socketRef.current?.emit('join-room', roomId.trim(), name.trim() || 'Guest');
  }

  // --- HTML UI RENDER ---
  return (
    <div className="app-shell">
      {!joined ? (
        <div className="join-panel">
          <div className="glass-card">
            <h1>Video Call</h1>
            <p>Join a room instantly. No login required.</p>
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Guest" />
            </label>
            <label>
              Room ID
              <input value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Example: FAMILY123" />
            </label>
            <div className="join-actions">
              <button onClick={joinRoom}>Join room</button>
              <button className="secondary" onClick={() => setRoomId(generateRoomId())}>Generate room</button>
            </div>
            {error && <p className="error" style={{ color: 'red', fontWeight: 'bold' }}>{error}</p>}
          </div>
        </div>
      ) : (
        <div className="call-layout">
          <header className="top-bar">
            <div><span className="label">Room</span><h2>{roomId}</h2></div>
            <div className="header-actions">
              <button className="danger" onClick={() => window.location.reload()}>Leave</button>
            </div>
          </header>

          {/* 🟢 FIX 3: Remote Video Component is safely wired up here */}
          <div className="video-grid">
            <div className="video-card local">
              <video ref={localVideoRef} autoPlay playsInline muted />
              <div className="video-tag">{name || 'You'}</div>
            </div>

            {Object.entries(remoteStreams).map(([userId, stream]) => (
              <RemoteVideo
                key={userId}
                stream={stream}
                name={participants.find((p) => p.id === userId)?.name}
              />
            ))}
          </div>

        </div>
      )}
    </div>
  );
}

export default App;