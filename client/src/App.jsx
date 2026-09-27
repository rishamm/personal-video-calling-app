import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_SERVER || 'http://localhost:3001';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const TURN_SERVER = import.meta.env.VITE_TURN_SERVER || null;
const TURN_USERNAME = import.meta.env.VITE_TURN_USERNAME || '';
const TURN_PASSWORD = import.meta.env.VITE_TURN_PASSWORD || '';

function getIceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];

  if (TURN_SERVER && TURN_USERNAME && TURN_PASSWORD) {
    servers.push({
      urls: TURN_SERVER,
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    });
  }

  return servers;
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

    localVideoRef.current.play().catch((err) => {
      console.warn('Autoplay for local preview was blocked:', err);
    });
  };

  const closePeerConnection = (userId) => {
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

    const peerConnection = new RTCPeerConnection({
      iceServers: getIceServers(),
      iceCandidatePoolSize: 10,
    });

    localStreamRef.current?.getTracks().forEach((track) => {
      peerConnection.addTrack(track, localStreamRef.current);
    });

    peerConnection.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('ice-candidate', { to: userId, candidate: event.candidate });
      }
    };

    peerConnection.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteStream) {
        setRemoteStreams((prev) => ({ ...prev, [userId]: remoteStream }));
      }
    };

    peerConnection.onconnectionstatechange = () => {
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
        console.warn('Failed to add queued ICE candidate:', err);
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
      console.error('Failed to flush pending offer:', err);
    }
  };

  const connectToUser = async (userId) => {
    if (!localStreamRef.current || !userId || !socketRef.current) return;

    const peerConnection = createPeerConnection(userId);

    if (negotiationLockRef.current[userId]) return;
    if (peerConnection.signalingState !== 'stable') return;

    negotiationLockRef.current[userId] = true;

    try {
      const offer = await peerConnection.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      });

      await peerConnection.setLocalDescription(offer);
      socketRef.current.emit('offer', { to: userId, offer });
      await flushPendingIceCandidates(userId);
    } catch (err) {
      console.error('Failed to create offer:', err);
      delete negotiationLockRef.current[userId];
    }
  };

  async function getLocalStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setError('This browser does not support camera and microphone access.');
      return null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: true,
      });

      localStreamRef.current = stream;
      attachLocalPreview(stream);
      return stream;
    } catch (err) {
      console.error('Media access failed:', err);
      setError('Camera and microphone access was denied. Please allow them and retry.');
      return null;
    }
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Connected to signaling server');
    });

    socket.on('current-users', (users) => {
      setParticipants(users);

      users.forEach((user) => {
        if (user.id !== socket.id) {
          connectToUser(user.id);
        }
      });
    });

    socket.on('user-joined', (user) => {
      setParticipants((prev) => {
        const exists = prev.some((participant) => participant.id === user.id);
        return exists ? prev : [...prev, user];
      });

      if (user.id !== socket.id) {
        connectToUser(user.id);
      }
    });

    socket.on('user-left', (userId) => {
      setParticipants((prev) => prev.filter((participant) => participant.id !== userId));
      setRemoteStreams((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });

      closePeerConnection(userId);
    });

    socket.on('offer', async ({ from, offer }) => {
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
        console.error('Error handling offer:', err);
      }
    });

    socket.on('answer', async ({ from, answer }) => {
      const peerConnection = peerConnectionsRef.current[from];
      if (!peerConnection) return;

      if (peerConnection.signalingState !== 'have-local-offer') {
        return;
      }

      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        delete negotiationLockRef.current[from];
        await flushPendingIceCandidates(from);
        await flushPendingOffer(from);
      } catch (err) {
        console.error('Error handling answer:', err);
      }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const peerConnection = peerConnectionsRef.current[from];

      if (!peerConnection) {
        if (!pendingIceCandidatesRef.current[from]) {
          pendingIceCandidatesRef.current[from] = [];
        }
        pendingIceCandidatesRef.current[from].push(candidate);
        return;
      }

      if (!peerConnection.remoteDescription) {
        if (!pendingIceCandidatesRef.current[from]) {
          pendingIceCandidatesRef.current[from] = [];
        }
        pendingIceCandidatesRef.current[from].push(candidate);
        return;
      }

      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Failed to add ICE candidate:', err);
      }
    });

    return () => {
      socket.disconnect();

      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
      }

      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
      peerConnectionsRef.current = {};
      negotiationLockRef.current = {};
      pendingRemoteOffersRef.current = {};
      pendingIceCandidatesRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (localStreamRef.current && localVideoRef.current) {
      attachLocalPreview(localStreamRef.current);
    }
  }, [joined]);

  async function joinRoom() {
    if (!roomId.trim()) {
      setError('Room name is required.');
      return;
    }

    const stream = await getLocalStream();
    if (!stream) return;

    const trimmedName = name.trim() || 'Guest';

    setJoined(true);
    setError('');
    setIsMuted(false);
    setIsCameraOff(false);

    socketRef.current?.emit('join-room', roomId.trim(), trimmedName);
  }

  function leaveRoom() {
    setJoined(false);
    setParticipants([]);
    setRemoteStreams({});
    setError('');

    Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    peerConnectionsRef.current = {};
    negotiationLockRef.current = {};
    pendingRemoteOffersRef.current = {};
    pendingIceCandidatesRef.current = {};

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }

    socketRef.current?.emit('leave-room', roomId);
  }

  function toggleMute() {
    if (!localStreamRef.current) return;
    const audioTrack = localStreamRef.current.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    setIsMuted(!audioTrack.enabled);
  }

  function toggleCamera() {
    if (!localStreamRef.current) return;
    const videoTrack = localStreamRef.current.getVideoTracks()[0];
    if (!videoTrack) return;

    videoTrack.enabled = !videoTrack.enabled;
    setIsCameraOff(!videoTrack.enabled);
  }

  async function copyRoomLink() {
    const shareUrl = `${window.location.origin}?room=${encodeURIComponent(roomId)}`;

    try {
      await navigator.clipboard.writeText(shareUrl);
      alert('Room link copied to clipboard.');
    } catch (err) {
      console.error('Failed to copy room URL:', err);
      alert(`Copy failed. Share this room ID: ${roomId}`);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');

    if (roomFromUrl) {
      setRoomId(roomFromUrl);
    }
  }, []);

  return (
    <div className="app-shell">
      {!joined ? (
        <div className="join-panel">
          <div className="glass-card">
            <h1>Video Call</h1>
            <p>Join a room instantly. No login required.</p>

            <label>
              Your name
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Guest"
              />
            </label>

            <label>
              Room ID
              <input
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                placeholder="Example: FAMILY123"
              />
            </label>

            <div className="join-actions">
              <button onClick={joinRoom}>Join room</button>
              <button className="secondary" onClick={() => setRoomId(generateRoomId())}>
                Generate room
              </button>
            </div>

            {error && <p className="error">{error}</p>}
          </div>
        </div>
      ) : (
        <div className="call-layout">
          <header className="top-bar">
            <div>
              <span className="label">Room</span>
              <h2>{roomId}</h2>
            </div>

            <div className="header-actions">
              <button className="secondary" onClick={copyRoomLink}>Copy link</button>
              <button className="danger" onClick={leaveRoom}>Leave</button>
            </div>
          </header>

          <div className="video-grid">
            <div className="video-card local">
              <video ref={localVideoRef} autoPlay playsInline muted />
              <div className="video-tag">{name || 'You'}</div>
            </div>

            {Object.entries(remoteStreams).map(([userId, stream]) => (
              <div className="video-card remote" key={userId}>
                <video
                  autoPlay
                  playsInline
                  ref={(videoElement) => {
                    if (videoElement) {
                      videoElement.srcObject = stream;
                    }
                  }}
                />
                <div className="video-tag">
                  {participants.find((participant) => participant.id === userId)?.name || 'Guest'}
                </div>
              </div>
            ))}
          </div>

          <div className="controls">
            <button onClick={toggleMute}>{isMuted ? 'Unmute' : 'Mute'}</button>
            <button onClick={toggleCamera}>{isCameraOff ? 'Turn camera on' : 'Turn camera off'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
