import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

const PORT = process.env.PORT || 3001;

app.use(express.static(path.join(__dirname, '../client/dist')));

const rooms = new Map();

io.on('connection', (socket) => {
  console.log(`User connected: ${socket.id}`);

  socket.on('join-room', (roomId, userName) => {
    if (!roomId) return;

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
    }

    const room = rooms.get(roomId);
    const displayName = userName || `Guest-${socket.id.slice(0, 4)}`;
    room.set(socket.id, { id: socket.id, name: displayName });
    socket.join(roomId);

    // The new participant receives the existing participants and is the
    // only side that creates offers. This prevents simultaneous offers and
    // the resulting setRemoteDescription InvalidStateError.
    const existingParticipants = Array.from(room.values()).filter(
      (user) => user.id !== socket.id,
    );
    socket.emit('current-users', existingParticipants);
  });

  socket.on('leave-room', (roomId) => {
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.delete(socket.id);
    socket.leave(roomId);
    io.to(roomId).emit('user-left', socket.id);

    if (room.size === 0) {
      rooms.delete(roomId);
    }
  });

  socket.on('offer', ({ to, offer }) => {
    if (to && offer) {
      socket.to(to).emit('offer', { from: socket.id, offer });
    }
  });

  socket.on('answer', ({ to, answer }) => {
    if (to && answer) {
      socket.to(to).emit('answer', { from: socket.id, answer });
    }
  });

  socket.on('ice-candidate', ({ to, candidate }) => {
    if (to && candidate) {
      socket.to(to).emit('ice-candidate', { from: socket.id, candidate });
    }
  });

  socket.on('disconnect', () => {
    console.log(`User disconnected: ${socket.id}`);

    for (const [roomId, room] of rooms.entries()) {
      if (room.has(socket.id)) {
        room.delete(socket.id);
        io.to(roomId).emit('user-left', socket.id);

        if (room.size === 0) {
          rooms.delete(roomId);
        }
      }
    }
  });
});

app.get('*', (req, res) => {
  const clientIndexPath = path.join(__dirname, '../client/dist/index.html');
  res.sendFile(clientIndexPath, (err) => {
    if (err) {
      res.status(404).send('App build not found. Run: npm run build');
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
