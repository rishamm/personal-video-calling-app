import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_SERVER || 'http://localhost:3001';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function getIceServers() {
  // Keeping it to ONE reliable STUN server to prevent local router confusion
  return [{ urls: 'stun:stun.l.google.com:19302' }];
}

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
    const configuration = { iceServers: getIceServers() };
    const peerConnection = new RTCPeerConnection(configuration);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStreamRef.current);
      });
    }

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', { to: userId, candidate: event.candidate });
      }
    };

    peerConnection.ontrack = (event) => {
      console.log(`[WebRTC] Received remote track from ${userId}`);
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
      } catch (err) {
        console.warn('[WebRTC] Failed to add ICE candidate:', err);
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
    // SECURITY CHECK: Warn if accessing via HTTP (not localhost)
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
      const msg = 'WebRTC blocks the camera on HTTP. You must use HTTPS or localhost to test this.';
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
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
    });
    socketRef.current = socket;

    socket.on('connect', () => console.log('[Socket] Connected to signaling server'));

    socket.on('current-users', (users) => {
      console.log('[Socket] Current users in room:', users);
      setParticipants(users);
      users.forEach((user) => connectToUser(user.id));
    });

    socket.on('user-joined', (user) => {
      console.log('[Socket] New user joined:', user.id);
      setParticipants((prev) => (prev.some((p) => p.id === user.id) ? prev : [...prev, user]));
      if (user.id !== socket.id) connectToUser(user.id);
    });

    socket.on('user-left', (userId) => {
      console.log('[Socket] User left:', userId);
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
      const peerConnection = peerConnectionsRef.current[from];
      if (!peerConnection || !peerConnection.remoteDescription) {
        if (!pendingIceCandidatesRef.current[from]) pendingIceCandidatesRef.current[from] = [];
        pendingIceCandidatesRef.current[from].push(candidate);
        return;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
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
    if (!stream) return; // Breaks out here if camera is blocked!

    setJoined(true);
    setError('');
    socketRef.current?.emit('join-room', roomId.trim(), name.trim() || 'Guest');
  }

  // --- HTML RENDER CODE REMAINS THE SAME, OMITTED FOR BREVITY ---
  // Ensure you keep your return ( <div className="app-shell"> ... ) from your original code!

  return (
    <div className="app-shell">
      {/* (Keep your original UI code here) */}
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
          <div className="video-grid">
            <div className="video-card local">
              <video ref={localVideoRef} autoPlay playsInline muted />
              <div className="video-tag">{name || 'You'}</div>
            </div>
            {Object.entries(remoteStreams).map(([userId, stream]) => (
              <div className="video-card remote" key={userId}>
                <video autoPlay playsInline ref={(el) => { if (el) el.srcObject = stream; }} />
                <div className="video-tag">{participants.find((p) => p.id === userId)?.name || 'Guest'}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;