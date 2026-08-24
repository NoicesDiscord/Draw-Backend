const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- UPGRADED GAME STATE ---
// Now stores objects: { socketId: { name: "Player", score: 0 } }
let players = {}; 
let currentWord = "";
let currentDrawerId = null;
const wordList = ["apple", "house", "car", "dog", "sun", "pizza", "mountain", "ocean", "guitar", "robot"];

// Helper to broadcast the leaderboard
function broadcastPlayers() {
  io.emit('update_players', Object.values(players));
}

function startNextRound() {
  const playerIds = Object.keys(players);
  if (playerIds.length === 0) return;

  currentDrawerId = playerIds[Math.floor(Math.random() * playerIds.length)];
  currentWord = wordList[Math.floor(Math.random() * wordList.length)];

  io.emit('round_update', {
    drawerName: players[currentDrawerId].name,
    wordLength: currentWord.length
  });

  io.to(currentDrawerId).emit('secret_word', currentWord);
}

io.on('connection', (socket) => {
  
  socket.on('join_game', (playerName) => {
    // Initialize player with a score of 0
    players[socket.id] = { name: playerName, score: 0 };
    broadcastPlayers(); // Tell everyone about the new player

    if (Object.keys(players).length >= 2 && !currentDrawerId) {
      startNextRound(); 
    }
  });

  socket.on('start', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('start', data) });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;

    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      // --- SCORING LOGIC ---
      // Give 10 points to the guesser
      player.score += 10;
      // Give 5 points to the drawer (if they exist)
      if (players[currentDrawerId]) {
        players[currentDrawerId].score += 5;
      }
      
      broadcastPlayers(); // Update everyone's scoreboard
      io.emit('chat_message', { sender: player.name, text: text, isGuess: true });
      
      io.emit('clear_board');
      setTimeout(startNextRound, 3000);
    } else {
      io.emit('chat_message', { sender: player.name, text: text, isGuess: false });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    broadcastPlayers(); // Update scoreboard when someone leaves
    if (socket.id === currentDrawerId) startNextRound(); 
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));