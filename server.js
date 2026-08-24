const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

io.on('connection', (socket) => {
  console.log('A player connected:', socket.id);

  socket.on('start', (data) => socket.broadcast.emit('start', data));
  socket.on('draw', (data) => socket.broadcast.emit('draw', data));
  socket.on('stop', () => socket.broadcast.emit('stop'));

  // ONE single chat listener
  socket.on('chat_message', (data) => {
    io.emit('chat_message', data);
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});