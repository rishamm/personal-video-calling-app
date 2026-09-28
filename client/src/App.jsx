import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_SERVER || 'http://localhost:3001';

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// 🟢 UNIFIED VIDEO PLAYER (Auto-mirrored, full object-cover support)
const VideoPlayer = ({ stream, isLocal }) => {
  const videoRef = useRef(null);
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);
  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={isLocal}
      style={{
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: 'scaleX(-1)', // Mirrored for BOTH local and remote as requested
        backgroundColor: '#111',
      }}
    />
  );
};

function App() {
  const [name, setName] = useState('Guest');
  const [roomId, setRoomId] = useState(generateRoomId());
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState('');
  
  const [participants, setParticipants] = useState([]);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [activeLocalStream, setActiveLocalStream] = useState(null);
  
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);

  // 🟢 NEW: State to track which video is Full Screen
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

  // 🟢 NEW: Auto-switch Full Screen to the remote user when they join
  useEffect(() => {
    const remoteIds = Object.keys(remoteStreams);
    if (remoteIds.length > 0 && mainStreamId === 'local') {
      setMainStreamId(remoteIds[0]); // Make them full screen
    } else if (remoteIds.length === 0 && mainStreamId !== 'local') {
      setMainStreamId('local'); // Revert to self if they leave
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
    } catch (err) {}
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
          } catch (err) {}
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
  };

  const createPeerConnection = (userId) => {
    if (peerConnectionsRef.current[userId]) return peerConnectionsRef.current[userId];
    const configuration = { 
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
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
      if (peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
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
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {}
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
    } catch (err) {}
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
      delete negotiationLockRef.current[userId];
    }
  };

  async function getLocalStream() {
    if (window.location.protocol === 'http:' && window.location.hostname !== 'localhost') {
      setError('WebRTC blocks the camera on HTTP. You must use HTTPS or localhost.');
      return null;
    }
    try {
      const constraints = {
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 15 } },
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
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
      if (joined) socket.emit('join-room', roomId.trim(), name.trim() || 'Guest');
    });

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
      } catch (err) {}
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
      } catch (err) {}
    });

    socket.on('ice-candidate', async ({ from, candidate }) => {
      const peerConnection = peerConnectionsRef.current[from];
      if (!peerConnection || !peerConnection.remoteDescription) {
        if (!pendingIceCandidatesRef.current[from]) pendingIceCandidatesRef.current[from] = [];
        pendingIceCandidatesRef.current[from].push(candidate);
        return;
      }
      try { await peerConnection.addIceCandidate(new RTCIceCandidate(candidate)); } catch (err) {}
    });

    return () => {
      socket.disconnect();
      if (localStreamRef.current) localStreamRef.current.getTracks().forEach((track) => track.stop());
      Object.values(peerConnectionsRef.current).forEach((pc) => pc.close());
    };
  }, [joined, roomId, name]);

  async function joinRoom() {
    if (!roomId.trim()) return setError('Room name is required.');
    const stream = await getLocalStream();
    if (!stream) return;
    setJoined(true);
    setError('');
    socketRef.current?.emit('join-room', roomId.trim(), name.trim() || 'Guest');
  }

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
      alert(`Copy failed. Room ID: ${roomId}`);
    }
  };

  // 🟢 GATHER ALL STREAMS FOR THE UI
  const allStreams = [
    { id: 'local', stream: activeLocalStream, isLocal: true, name: 'You' },
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
    <div style={{ fontFamily: 'system-ui, sans-serif' }}>
      {!joined ? (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100vh', background: '#121212', color: 'white' }}>
          <div style={{ background: '#222', padding: '2rem', borderRadius: '12px', textAlign: 'center', width: '90%', maxWidth: '400px' }}>
            <h1 style={{ marginBottom: '1rem' }}>Video Call</h1>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input style={{ padding: '0.8rem', borderRadius: '6px', border: '1px solid #444', background: '#111', color: 'white' }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Your Name" />
              <input style={{ padding: '0.8rem', borderRadius: '6px', border: '1px solid #444', background: '#111', color: 'white' }} value={roomId} onChange={(e) => setRoomId(e.target.value)} placeholder="Room ID" />
              <button style={{ padding: '1rem', background: '#25D366', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold' }} onClick={joinRoom}>Join Room</button>
            </div>
            {error && <p style={{ color: '#ff4444', marginTop: '1rem' }}>{error}</p>}
          </div>
        </div>
      ) : (
        // 🟢 WHATSAPP-STYLE FULL SCREEN UI
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: '#000', overflow: 'hidden' }}>
          
          {/* Main Full-Screen Video Background */}
          {mainStreamData && (
            <div style={{ position: 'absolute', inset: 0, zIndex: 1 }}>
              <VideoPlayer stream={mainStreamData.stream} isLocal={mainStreamData.isLocal} />
            </div>
          )}

          {/* Top Header Gradient (Name & Link) */}
          <div style={{ position: 'absolute', top: 0, width: '100%', padding: '40px 20px 20px', background: 'linear-gradient(to bottom, rgba(0,0,0,0.7), transparent)', zIndex: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div style={{ color: 'white' }}>
              <h2 style={{ margin: 0, fontSize: '22px', fontWeight: '500', textShadow: '0 1px 3px rgba(0,0,0,0.5)' }}>
                {mainStreamData?.name || 'Waiting...'}
              </h2>
              <span style={{ fontSize: '13px', color: '#ccc' }}>End-to-end encrypted</span>
            </div>
            <button onClick={copyRoomLink} style={{ background: 'rgba(255,255,255,0.2)', border: 'none', color: 'white', padding: '8px 16px', borderRadius: '20px', backdropFilter: 'blur(10px)', cursor: 'pointer' }}>
              Add / Link
            </button>
          </div>

          {/* Floating PiP Videos (Tap to switch) */}
          <div style={{ position: 'absolute', bottom: '130px', right: '20px', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: 10 }}>
            {pipStreamsData.map((s) => (
              <div 
                key={s.id} 
                onClick={() => setMainStreamId(s.id)} // 👈 TAP TO SWAP VIEWS
                style={{ width: '100px', height: '150px', borderRadius: '12px', overflow: 'hidden', border: '1.5px solid rgba(255,255,255,0.3)', boxShadow: '0 4px 12px rgba(0,0,0,0.5)', cursor: 'pointer', background: '#222' }}
              >
                <VideoPlayer stream={s.stream} isLocal={s.isLocal} />
              </div>
            ))}
          </div>

          {/* Bottom WhatsApp-Style Controls overlay */}
          <div style={{ position: 'absolute', bottom: 0, width: '100%', padding: '30px 20px', background: 'linear-gradient(to top, rgba(0,0,0,0.8), transparent)', zIndex: 10, display: 'flex', justifyContent: 'space-evenly', alignItems: 'center' }}>
            
            {/* Camera Toggle */}
            <button onClick={toggleVideo} style={{ width: '56px', height: '56px', borderRadius: '50%', background: isCameraOff ? 'white' : 'rgba(255,255,255,0.2)', border: 'none', backdropFilter: 'blur(10px)', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill={isCameraOff ? "black" : "white"}>
                <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h13c.55 0 1-.45 1-1v-3.5l4 4v-11z" />
                {isCameraOff && <line x1="2" y1="2" x2="22" y2="22" stroke="black" strokeWidth="2" />}
              </svg>
            </button>

            {/* Mic Toggle */}
            <button onClick={toggleMute} style={{ width: '56px', height: '56px', borderRadius: '50%', background: isMuted ? 'white' : 'rgba(255,255,255,0.2)', border: 'none', backdropFilter: 'blur(10px)', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill={isMuted ? "black" : "white"}>
                <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
                {isMuted && <line x1="4" y1="4" x2="20" y2="20" stroke="black" strokeWidth="2" />}
              </svg>
            </button>

            {/* End Call Button (Red) */}
            <button onClick={() => window.location.reload()} style={{ width: '64px', height: '64px', borderRadius: '50%', background: '#ff3b30', border: 'none', cursor: 'pointer', display: 'flex', justifyContent: 'center', alignItems: 'center', boxShadow: '0 4px 12px rgba(255,59,48,0.4)' }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="white" style={{ transform: 'rotate(135deg)' }}>
                <path d="M17 19.22H5V7h7V5H5c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-7h-2v7.22z"/>
                <path d="M19 2h-8v2h5.59L5 15.59 6.41 17 18 5.41V11h2V2z"/>
              </svg>
            </button>

          </div>
        </div>
      )}
    </div>
  );
}

export default App;
