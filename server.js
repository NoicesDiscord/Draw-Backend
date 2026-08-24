const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors()); // This allows your frontend to talk to the backend
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*", // We will lock this down to your specific frontend URL later for security
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  // Listen for strokes and instantly broadcast them to everyone else
  socket.on('start', (data) => socket.broadcast.emit('start', data));
  socket.on('draw', (data) => socket.broadcast.emit('draw', data));
  socket.on('stop', () => socket.broadcast.emit('stop'));

  io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  // Existing drawing listeners...
  socket.on('start', (data) => socket.broadcast.emit('start', data));
  socket.on('draw', (data) => socket.broadcast.emit('draw', data));
  socket.on('stop', () => socket.broadcast.emit('stop'));

  // NEW: Chat listener
  socket.on('chat_message', (data) => {
    // When the server receives a message, broadcast it to EVERYONE in the room (including the sender)
    io.emit('chat_message', data);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
  });
});

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});