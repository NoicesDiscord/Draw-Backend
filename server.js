const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- GAME STATE ---
let players = {}; // Tracks connected players: { socketId: playerName }
let currentWord = "";
let currentDrawerId = null;
const wordList = ["apple", "house", "car", "dog", "sun", "pizza", "mountain", "ocean", "guitar", "robot"];

function startNextRound() {
  const playerIds = Object.keys(players);
  if (playerIds.length === 0) return;

  // 1. Pick a random drawer and a random word
  currentDrawerId = playerIds[Math.floor(Math.random() * playerIds.length)];
  currentWord = wordList[Math.floor(Math.random() * wordList.length)];

  console.log(`New round! Drawer: ${players[currentDrawerId]}, Word: ${currentWord}`);

  // 2. Tell everyone who is drawing
  io.emit('round_update', {
    drawerName: players[currentDrawerId],
    wordLength: currentWord.length
  });

  // 3. Tell ONLY the drawer the actual secret word
  io.to(currentDrawerId).emit('secret_word', currentWord);
}

io.on('connection', (socket) => {
  // 1. Register the player
  socket.on('join_game', (playerName) => {
    players[socket.id] = playerName;
    // If we have at least 2 players and no one is drawing, start the game!
    if (Object.keys(players).length >= 2 && !currentDrawerId) {
      startNextRound(); 
    }
  });

  // 2. Drawing events (Security Check: only broadcast if they are the chosen drawer!)
  socket.on('start', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('start', data) });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });

  // 3. Secure Chat & Guess Logic
  socket.on('chat_message', (text) => {
    const senderName = players[socket.id] || "Unknown";

    // Check if the message matches the secret word
    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      // Correct guess!
      io.emit('chat_message', { sender: senderName, text: text, isGuess: true });
      
      // Clear the canvas and rotate turns after 3 seconds
      io.emit('clear_board');
      setTimeout(startNextRound, 3000);
    } else {
      // Normal message
      io.emit('chat_message', { sender: senderName, text: text, isGuess: false });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    if (socket.id === currentDrawerId) startNextRound(); // Skip turn if drawer leaves
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));