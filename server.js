const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

// Import our decoupled Logic!
const { rooms } = require('./src/state/state');
const initializeSockets = require('./src/socket/socketManager');

const app = express();
app.use(cors());
const server = http.createServer(app);
 
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- API Routes ---
app.get('/api/rooms', (req, res) => {
  const customRooms = Object.values(rooms)
    .filter(r => r.isPrivate)
    .map(r => ({
      id: r.id,
      hostName: r.players[r.hostId] ? r.players[r.hostId].name : 'Unknown Host',
      players: Object.keys(r.players).length,
      maxPlayers: r.maxPlayers,
      hasPassword: !!r.password // Only tells frontend IF there is a password, doesn't reveal it!
    }));
  res.json(customRooms);
});

app.get('/api/validate-password', (req, res) => {
  const { roomId, password } = req.query;
  const room = rooms[roomId];
  if (!room) return res.json({ success: false, message: "This room does not exist or has expired." });
  if (room.isPrivate && room.password && room.password !== password) {
    return res.json({ success: false, message: "Incorrect room password." });
  }
  res.json({ success: true });
});

// --- Initialize all socket logic securely ---
initializeSockets(io);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));