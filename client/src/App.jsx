import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_SERVER || 'http://localhost:3001';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

const RemoteVideo = ({ stream, name }) => {
  const videoRef = useRef(null);
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div className="video-card remote">
      <video ref={videoRef} autoPlay playsInline style={{ transform: 'scaleX(-1)' }} />
      <div className="video-tag">{name || 'Guest'}</div>
    </div>
  );
};

const LocalVideo = ({ stream, name }) => {
  const videoRef = useRef(null);
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <div className="video-card local">
      <video ref={videoRef} autoPlay playsInline muted style={{ transform: 'scaleX(-1)' }} />
      <div className="video-tag">{name || 'You'}</div>
    </div>
  );
};

function App() {
  const [name, setName] = useState('Guest');
  const [roomId, setRoomId] = useState('');
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [activeLocalStream, setActiveLocalStream] = useState(null);

  const [mainStreamId, setMainStreamId] = useState('local');

  const socketRef = useRef(null);
  const localStreamRef = useRef(null);
  const peerConnectionsRef = useRef({});
  const negotiationLockRef = useRef({});
  const pendingRemoteOffersRef = useRef({});
  const pendingIceCandidatesRef = useRef({});

  // Auto-fill room ID if someone clicks a shared link
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const roomFromUrl = params.get('room');
    if (roomFromUrl) {
      setRoomId(roomFromUrl);
    }
  }, []);

  // Auto-switch Full Screen to the remote user when they join
  useEffect(() => {
    const remoteIds = Object.keys(remoteStreams);
    if (remoteIds.length > 0 && mainStreamId === 'local') {
      setMainStreamId(remoteIds[0]);
    } else if (remoteIds.length === 0 && mainStreamId !== 'local') {
      setMainStreamId('local');
    } else if (mainStreamId !== 'local' && !remoteStreams[mainStreamId]) {
      setMainStreamId(remoteIds.length > 0 ? remoteIds[0] : 'local');
    }
  }, [remoteStreams, mainStreamId]);

  const applyLowBandwidthConstraints = async (peerConnection) => {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find((s) => s.track && s.track.kind === 'video');

    if (!videoSender || !videoSender.getParameters) return;

    try {
      const parameters = videoSender.getParameters();
      if (!parameters.encodings || parameters.encodings.length === 0) {
        parameters.encodings = [{}];
      }
      parameters.encodings[0].maxBitrate = 200000;
      parameters.encodings[0].scaleResolutionDownBy = 1.5;
      parameters.encodings[0].maxFramerate = 15;
      await videoSender.setParameters(parameters);
    } catch (err) { }
  };

  useEffect(() => {
    const handleVisibilityChange = async () => {
      if (document.visibilityState === 'visible' && joined) {
        const videoTrack = localStreamRef.current?.getVideoTracks()[0];

        if (!videoTrack || videoTrack.readyState === 'ended') {
          try {
            const newStream = await getLocalStream();
            if (!newStream) return;

            Object.values(peerConnectionsRef.current).forEach(async (pc) => {
              const videoSender = pc.getSenders().find((s) => s.track?.kind === 'video');
              if (videoSender && newStream.getVideoTracks()[0]) {
                await videoSender.replaceTrack(newStream.getVideoTracks()[0]);
                await applyLowBandwidthConstraints(pc);
              }
              const audioSender = pc.getSenders().find((s) => s.track?.kind === 'audio');
              if (audioSender && newStream.getAudioTracks()[0]) {
                await audioSender.replaceTrack(newStream.getAudioTracks()[0]);
              }
            });
          } catch (err) { }
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [joined, isCameraOff, isMuted]);

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

    // Clear video immediately to prevent frozen frame if disconnected
    setRemoteStreams((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
  };

  const createPeerConnection = (userId) => {
    if (peerConnectionsRef.current[userId]) return peerConnectionsRef.current[userId];

    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' } // Secondary fallback to ensure connectivity
      ],
      iceCandidatePoolSize: 2
    };

    const peerConnection = new RTCPeerConnection(configuration);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        peerConnection.addTrack(track, localStreamRef.current);
      });
      applyLowBandwidthConstraints(peerConnection);
    }

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
      const state = peerConnection.connectionState;
      if (state === 'failed' || state === 'disconnected' || state === 'closed') {
        closePeerConnection(userId);
        // Robust reconnect mechanism: Try to rebuild connection if we dropped
        setParticipants(prev => {
          const stillInRoom = prev.some(p => p.id === userId);
          if (stillInRoom && socketRef.current?.id < userId) {
            setTimeout(() => connectToUser(userId), 2000);
          }
          return prev;
        });
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
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (err) { }
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
      await applyLowBandwidthConstraints(peerConnection);
    } catch (err) { }
  };

  const connectToUser = async (userId) => {
    if (!localStreamRef.current || !userId || !socketRef.current) return;

    const peerConnection = createPeerConnection(userId);

    if (negotiationLockRef.current[userId] || peerConnection.signalingState !== 'stable') return;
    negotiationLockRef.current[userId] = true;

    try {
      const offer = await peerConnection.createOffer();
      await peerConnection.setLocalDescription(offer);
      socketRef.current.emit('offer', { to: userId, offer });
      await flushPendingIceCandidates(userId);
      await applyLowBandwidthConstraints(peerConnection);
    } catch (err) {
      // Allow retry if failed
    } finally {
      // Clear lock after a timeout just in case it deadlocks
      setTimeout(() => {
        if (negotiationLockRef.current) {
          delete negotiationLockRef.current[userId];
        }
      }, 5000);
    }
  };

  async function getLocalStream() {
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
      setError('WebRTC blocks the camera on HTTP. You must use HTTPS or localhost.');
      return null;
    }
    try {
      const constraints = {
        video: {
          width: { ideal: 640, max: 854 },
          height: { ideal: 360, max: 480 },
          frameRate: { ideal: 15, max: 20 },
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;
      setActiveLocalStream(stream);
      return stream;
    } catch (err) {
      setError('Camera/Mic access denied.');
      return null;
    }
  }

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
    });
    socketRef.current = socket;

    socket.io.on('reconnect', () => {
      if (joined) {
        socket.emit('join-room', roomId.trim(), name.trim() || 'Guest');
      }
    });

    socket.on('current-users', (users) => {
      setParticipants(users);
      const myId = socket.id;
      // Guaranteed to only trigger one side to initiate the offer preventing glares
      users.forEach((user) => {
        if (myId < user.id) connectToUser(user.id);
      });
    });

    socket.on('user-joined', (user) => {
      setParticipants((prev) => (prev.some((p) => p.id === user.id) ? prev : [...prev, user]));
      const myId = socket.id;
      // Guaranteed to only trigger one side to initiate the offer preventing glares
      if (myId < user.id) connectToUser(user.id);
    });

    socket.on('user-left', (userId) => {
      setParticipants((prev) => prev.filter((p) => p.id !== userId));
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
        await applyLowBandwidthConstraints(peerConnection);
      } catch (err) { }
    });

    socket.on('answer', async ({ from, answer }) => {
      const peerConnection = peerConnectionsRef.current[from];
      if (!peerConnection || peerConnection.signalingState !== 'have-local-offer') return;
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        delete negotiationLockRef.current[from];
        await flushPendingIceCandidates(from);
        await flushPendingOffer(from);
        await applyLowBandwidthConstraints(peerConnection);
      } catch (err) { }
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const peerConnection = peerConnectionsRef.current[from];
      if (!peerConnection || !peerConnection.remoteDescription) {
        if (!pendingIceCandidatesRef.current[from]) pendingIceCandidatesRef.current[from] = [];
        pendingIceCandidatesRef.current[from].push(candidate);
        return;
      }
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); }
      catch (err) { }
    });

    return () => {
      socket.disconnect();
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((track) => track.stop());
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    };
  }, [joined, roomId, name]);

  async function joinRoom(idToJoin = roomId) {
    if (!idToJoin.trim()) return setError('Room ID is required.');
    const stream = await getLocalStream();
    if (!stream) return;

    setJoined(true);
    setError('');
    socketRef.current?.emit('join-room', idToJoin.trim(), name.trim() || 'Guest');
  }

  const handleCreateAndJoin = async () => {
    const newRoomId = generateRoomId();
    setRoomId(newRoomId);
    await joinRoom(newRoomId);
  };

  const toggleMute = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        setIsMuted(!audioTrack.enabled);
      }
    }
  };

  const toggleVideo = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        setIsCameraOff(!videoTrack.enabled);
      }
    }
  };

  const copyRoomLink = async () => {
    const shareUrl = `${window.location.origin}?room=${encodeURIComponent(roomId)}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      alert('Link copied to clipboard! Share it with others to join.');
    } catch (err) {
      alert(`Copy failed. Please manually share this Room ID: ${roomId}`);
    }
  };

  // MAP ALL STREAMS FOR SWITCHING LOGIC
  const allStreams = [
    { id: 'local', stream: activeLocalStream, isLocal: true, name: name || 'You' },
    ...Object.entries(remoteStreams).map(([id, stream]) => ({
      id,
      stream,
      isLocal: false,
      name: participants.find((p) => p.id === id)?.name || 'Guest'
    }))
  ];

  const mainStreamData = allStreams.find(s => s.id === mainStreamId) || allStreams[0];
  const pipStreamsData = allStreams.filter(s => s.id !== mainStreamData?.id);

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
              Room ID (Optional)
              <input value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Enter code to join existing" />
            </label>
            <div className="join-actions">
              <button onClick={() => joinRoom(roomId)}>Join room</button>
              <button className="secondary" onClick={handleCreateAndJoin}>Create & Join</button>
            </div>
            {error && <p className="error" style={{ color: 'red', fontWeight: 'bold' }}>{error}</p>}
          </div>
        </div>
      ) : (
        <div className="call-layout">
          <header className="top-bar">
            <div><span className="label">Room</span><h2>{roomId}</h2></div>
            <div className="header-actions">
              <button className="secondary" onClick={copyRoomLink} style={{ marginRight: '10px' }}>
                Copy Link
              </button>
              <button className={isMuted ? "danger" : "secondary"} onClick={toggleMute} style={{ marginRight: '10px' }}>
                {isMuted ? 'Unmute' : 'Mute'}
              </button>
              <button className={isCameraOff ? "danger" : "secondary"} onClick={toggleVideo} style={{ marginRight: '20px' }}>
                {isCameraOff ? 'Camera On' : 'Camera Off'}
              </button>
              <button className="danger" onClick={() => window.location.reload()}>Leave</button>
            </div>
          </header>

          {/* Main + PiP Display */}
          <div style={{ position: 'relative', flex: 1, width: '100%', height: '100%', minHeight: '600px', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>

            {/* Main Full-Screen Video */}
            <div style={{ width: '100%', height: '100%', position: 'absolute', inset: 0 }}>
              {mainStreamData?.isLocal ? (
                <LocalVideo stream={mainStreamData.stream} name={mainStreamData.name} />
              ) : (
                <RemoteVideo stream={mainStreamData?.stream} name={mainStreamData?.name} />
              )}
            </div>

            {/* Google Meet Style "Waiting for others" popup */}
            {participants.length === 0 && (
              <div style={{
                position: 'absolute',
                bottom: '30px',
                left: '30px',
                backgroundColor: 'rgba(30, 30, 30, 0.9)',
                padding: '20px',
                borderRadius: '12px',
                zIndex: 20,
                color: 'white',
                maxWidth: '320px',
                boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
                border: '1px solid rgba(255,255,255,0.1)'
              }}>
                <h3 style={{ marginTop: 0, marginBottom: '8px', fontSize: '18px', fontWeight: '500' }}>Your meeting's ready</h3>
                <p style={{ margin: 0, marginBottom: '16px', fontSize: '14px', color: '#ccc', lineHeight: '1.4' }}>
                  Share this meeting link with others you want in the meeting.
                </p>
                <button
                  onClick={copyRoomLink}
                  style={{
                    width: '100%',
                    padding: '10px 16px',
                    backgroundColor: '#1a73e8',
                    border: 'none',
                    borderRadius: '4px',
                    color: 'white',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    fontSize: '14px'
                  }}
                >
                  Copy joining info
                </button>
              </div>
            )}

            {/* Floating PiP Videos (Click to Swap) */}
            <div style={{ position: 'absolute', bottom: '20px', right: '20px', display: 'flex', flexDirection: 'column', gap: '15px', zIndex: 10 }}>
              {pipStreamsData.map((s) => (
                <div
                  key={s.id}
                  onClick={() => setMainStreamId(s.id)}
                  style={{
                    width: '140px',
                    cursor: 'pointer',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    boxShadow: '0 8px 16px rgba(0,0,0,0.6)',
                    border: '2px solid rgba(255,255,255,0.7)',
                    transition: 'transform 0.2s ease-in-out'
                  }}
                  onMouseOver={(e) => e.currentTarget.style.transform = 'scale(1.05)'}
                  onMouseOut={(e) => e.currentTarget.style.transform = 'scale(1)'}
                >
                  {s.isLocal ? (
                    <LocalVideo stream={s.stream} name={s.name} />
                  ) : (
                    <RemoteVideo stream={s.stream} name={s.name} />
                  )}
                </div>
              ))}
            </div>

          </div>
        </div>
      )}
    </div>
  );
}

export default App;