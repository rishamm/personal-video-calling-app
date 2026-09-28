import { useCallback, useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_SERVER || 'http://localhost:3001';

// Same public STUN servers as the original app.
const STUN_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ],
  iceCandidatePoolSize: 4,
};

/**
 * Optional: set VITE_ICE_ENDPOINT (e.g. https://your-backend.com/api/ice-servers) to load
 * TURN servers from your backend later. When it's not set, STUN-only is used.
 */
async function loadRtcConfig() {
  const endpoint = import.meta.env.VITE_ICE_ENDPOINT;
  if (!endpoint) return STUN_CONFIG;
  try {
    const res = await fetch(endpoint, { cache: 'no-store' });
    if (!res.ok) throw new Error(`ICE server request failed (${res.status})`);
    const { iceServers } = await res.json();
    return { ...STUN_CONFIG, iceServers };
  } catch (err) {
    console.warn('Could not load ICE servers, using STUN only:', err);
    return STUN_CONFIG;
  }
}

const VIDEO_CONSTRAINTS = {
  width: { ideal: 854, max: 1280 },
  height: { ideal: 480, max: 720 },
  frameRate: { ideal: 24, max: 30 },
  facingMode: 'user',
};
const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

async function acquireMedia() {
  if (!window.isSecureContext) {
    throw Object.assign(new Error('Calls need a secure connection. Open this page over HTTPS.'), {
      name: 'InsecureContext',
    });
  }
  const gum = (c) => navigator.mediaDevices.getUserMedia(c);
  try {
    return await gum({ video: VIDEO_CONSTRAINTS, audio: AUDIO_CONSTRAINTS });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw err;
    // No camera or camera busy: fall back to audio only.
    return gum({ audio: AUDIO_CONSTRAINTS });
  }
}

function describeMediaError(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Camera and microphone access is blocked. Allow access in your browser’s address bar, then try again.';
    case 'NotFoundError':
      return 'No camera or microphone was found on this device.';
    case 'NotReadableError':
      return 'Your camera or microphone is being used by another app.';
    default:
      return err.message || 'Could not start your camera and microphone.';
  }
}

export function useCall() {
  const [status, setStatus] = useState('idle'); // idle | joining | in-call
  const [error, setError] = useState('');
  const [room, setRoom] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [peers, setPeers] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isCameraOff, setIsCameraOff] = useState(false);
  const [isSharing, setIsSharing] = useState(false);
  const [signalOnline, setSignalOnline] = useState(false);

  const socketRef = useRef(null);
  const cameraStreamRef = useRef(null);
  const screenTrackRef = useRef(null);
  const peersRef = useRef({});
  const sessionRef = useRef(null);
  const rtcConfigRef = useRef(null);

  const patchPeer = useCallback((id, patch) => {
    setPeers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...patch } } : prev));
  }, []);

  const closePeer = useCallback((id) => {
    const peer = peersRef.current[id];
    if (!peer) return;
    const { pc } = peer;
    pc.ontrack = pc.onicecandidate = pc.onnegotiationneeded = pc.onconnectionstatechange = null;
    pc.close();
    delete peersRef.current[id];
    setPeers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const closeAllPeers = useCallback(() => {
    Object.keys(peersRef.current).forEach(closePeer);
  }, [closePeer]);

  /** Creates (or returns) the connection for a remote user. */
  const createPeer = useCallback(
    (id, name) => {
      const existing = peersRef.current[id];
      if (existing) {
        if (name) patchPeer(id, { name });
        return existing;
      }

      const socket = socketRef.current;
      const pc = new RTCPeerConnection(rtcConfigRef.current ?? STUN_CONFIG);
      const peer = {
        pc,
        // Deterministic roles so both sides agree without extra signaling.
        initiator: socket.id < id,
        polite: socket.id > id,
        makingOffer: false,
        ignoreOffer: false,
        queuedCandidates: [],
        fallbackStream: null,
      };
      peersRef.current[id] = peer;
      setPeers((prev) => ({
        ...prev,
        [id]: { id, name: name || 'Guest', stream: null, connectionState: 'new' },
      }));

      // Send what we have, and always be able to receive audio + video.
      const cam = cameraStreamRef.current;
      const audio = cam?.getAudioTracks()[0];
      const video = screenTrackRef.current || cam?.getVideoTracks()[0];
      if (audio) pc.addTrack(audio, cam);
      else pc.addTransceiver('audio', { direction: 'recvonly' });
      if (video) pc.addTrack(video, cam);
      else pc.addTransceiver('video', { direction: 'recvonly' });

      pc.onicecandidate = ({ candidate }) => {
        if (candidate) socket.emit('ice-candidate', { to: id, candidate });
      };

      pc.ontrack = ({ track, streams }) => {
        let stream = streams[0];
        if (!stream) {
          stream = peer.fallbackStream ||= new MediaStream();
          stream.addTrack(track);
        }
        patchPeer(id, { stream });
      };

      pc.onnegotiationneeded = async () => {
        // The non-initiator waits for the first offer instead of racing it.
        if (!peer.initiator && !pc.remoteDescription) return;
        try {
          peer.makingOffer = true;
          await pc.setLocalDescription();
          socket.emit('offer', { to: id, offer: pc.localDescription });
        } catch (err) {
          console.error('Negotiation failed', err);
        } finally {
          peer.makingOffer = false;
        }
      };

      pc.onconnectionstatechange = () => {
        patchPeer(id, { connectionState: pc.connectionState });
        // Network changed or path died: renegotiate ICE instead of dropping the call.
        if (pc.connectionState === 'failed') pc.restartIce();
      };

      return peer;
    },
    [patchPeer],
  );

  /** "Perfect negotiation": handles offers/answers and simultaneous-offer collisions. */
  const handleDescription = useCallback(
    async (from, description) => {
      const peer = createPeer(from);
      const { pc } = peer;
      try {
        const collision =
          description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description); // polite peer rolls back implicitly
        for (const c of peer.queuedCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {});
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          socketRef.current.emit('answer', { to: from, answer: pc.localDescription });
        }
      } catch (err) {
        console.error('Could not apply remote description', err);
      }
    },
    [createPeer],
  );

  const handleCandidate = useCallback(async (from, candidate) => {
    const peer = peersRef.current[from];
    if (!peer) return;
    if (!peer.pc.remoteDescription) {
      peer.queuedCandidates.push(candidate);
      return;
    }
    try {
      await peer.pc.addIceCandidate(candidate);
    } catch (err) {
      if (!peer.ignoreOffer) console.warn('ICE candidate rejected', err);
    }
  }, []);

  // One socket for the whole lifetime of the hook.
  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket'],
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setSignalOnline(true);
      const session = sessionRef.current;
      if (session) {
        // Reconnected mid-call: our socket id changed, so rebuild the mesh.
        closeAllPeers();
        socket.emit('join-room', session.id, session.name);
      }
    });
    socket.on('disconnect', () => setSignalOnline(false));
    socket.on('current-users', (users) => users.forEach((u) => createPeer(u.id, u.name)));
    socket.on('user-joined', (user) => createPeer(user.id, user.name));
    socket.on('user-left', closePeer);
    socket.on('offer', ({ from, offer }) => handleDescription(from, offer));
    socket.on('answer', ({ from, answer }) => handleDescription(from, answer));
    socket.on('ice-candidate', ({ from, candidate }) => handleCandidate(from, candidate));

    return () => {
      sessionRef.current = null;
      closeAllPeers();
      cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenTrackRef.current?.stop();
      socket.disconnect();
    };
  }, [closeAllPeers, closePeer, createPeer, handleCandidate, handleDescription]);

  const replaceOutgoingVideo = useCallback(async (track) => {
    await Promise.all(
      Object.values(peersRef.current).map(({ pc }) => {
        const sender = pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
        return sender?.replaceTrack(track).catch(() => {});
      }),
    );
  }, []);

  const join = useCallback(async (roomId, name) => {
    setError('');
    setStatus('joining');
    try {
      const [stream, rtcConfig] = await Promise.all([acquireMedia(), loadRtcConfig()]);
      rtcConfigRef.current = rtcConfig;
      cameraStreamRef.current = stream;
      setLocalStream(stream);
      setIsMuted(false);
      setIsCameraOff(stream.getVideoTracks().length === 0);
      sessionRef.current = { id: roomId, name };
      setRoom({ id: roomId, name });
      setStatus('in-call');
      const socket = socketRef.current;
      // If the socket is still connecting, its 'connect' handler joins for us.
      if (socket.connected) socket.emit('join-room', roomId, name);
    } catch (err) {
      setError(describeMediaError(err));
      setStatus('idle');
    }
  }, []);

  const leave = useCallback(() => {
    sessionRef.current = null;
    closeAllPeers();
    screenTrackRef.current?.stop();
    screenTrackRef.current = null;
    cameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    cameraStreamRef.current = null;
    setLocalStream(null);
    setRoom(null);
    setIsSharing(false);
    setStatus('idle');
    // Reconnecting makes the server broadcast 'user-left' to everyone else.
    const socket = socketRef.current;
    socket.disconnect();
    socket.connect();
  }, [closeAllPeers]);

  const toggleMute = useCallback(() => {
    const track = cameraStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsMuted(!track.enabled);
  }, []);

  const toggleCamera = useCallback(() => {
    const track = cameraStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    setIsCameraOff(!track.enabled);
  }, []);

  const stopScreenShare = useCallback(async () => {
    const track = screenTrackRef.current;
    if (!track) return;
    track.onended = null;
    track.stop();
    screenTrackRef.current = null;
    const cam = cameraStreamRef.current;
    await replaceOutgoingVideo(cam?.getVideoTracks()[0] ?? null);
    setLocalStream(cam ? new MediaStream(cam.getTracks()) : null);
    setIsSharing(false);
  }, [replaceOutgoingVideo]);

  const toggleScreenShare = useCallback(async () => {
    if (screenTrackRef.current) return stopScreenShare();
    const cam = cameraStreamRef.current;
    if (!cam?.getVideoTracks().length) return;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } } });
      const track = display.getVideoTracks()[0];
      track.onended = stopScreenShare; // browser's own "Stop sharing" button
      screenTrackRef.current = track;
      await replaceOutgoingVideo(track);
      setLocalStream(new MediaStream([track, ...cam.getAudioTracks()]));
      setIsSharing(true);
    } catch {
      /* person cancelled the picker */
    }
  }, [replaceOutgoingVideo, stopScreenShare]);

  // Mobile browsers kill the camera when the tab is backgrounded: bring it back.
  useEffect(() => {
    if (status !== 'in-call') return undefined;
    const onVisible = async () => {
      const cam = cameraStreamRef.current;
      const old = cam?.getVideoTracks()[0];
      if (document.visibilityState !== 'visible' || !old || old.readyState !== 'ended') return;
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
        const track = fresh.getVideoTracks()[0];
        track.enabled = old.enabled;
        cam.removeTrack(old);
        cam.addTrack(track);
        if (!screenTrackRef.current) {
          await replaceOutgoingVideo(track);
          setLocalStream(new MediaStream(cam.getTracks()));
        }
      } catch {
        /* camera still unavailable; try again next time the tab is shown */
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [status, replaceOutgoingVideo]);

  return {
    status, error, room, localStream, peers: Object.values(peers), signalOnline,
    isMuted, isCameraOff, isSharing,
    canShareScreen: !!localStream?.getVideoTracks().length || isSharing,
    join, leave, toggleMute, toggleCamera, toggleScreenShare,
  };
}