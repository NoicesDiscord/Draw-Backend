const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- GAME STATE ---
let players = {}; 
let currentWord = "";
let currentDrawerId = null;
const wordList = ["apple", "house", "car", "dog", "sun", "pizza", "mountain", "ocean", "guitar", "robot"];

function broadcastPlayers() {
  io.emit('update_players', Object.values(players));
}

function startNextRound() {
  const playerIds = Object.keys(players);
  
  // Safety check: Don't start if fewer than 2 players
  if (playerIds.length < 2) {
    currentDrawerId = null;
    return;
  }

  currentDrawerId = playerIds[Math.floor(Math.random() * playerIds.length)];
  currentWord = wordList[Math.floor(Math.random() * wordList.length)];

  io.emit('round_update', {
    drawerName: players[currentDrawerId].name,
    wordLength: currentWord.length
  });
  
  // Always clear the board when a new round starts
  io.emit('clear_board'); 
  io.to(currentDrawerId).emit('secret_word', currentWord);
}

io.on('connection', (socket) => {
  
  socket.on('join_game', (playerName) => {
    players[socket.id] = { name: playerName, score: 0 };
    broadcastPlayers(); 

    // 1. If we have enough players and no one is drawing, start!
    if (Object.keys(players).length >= 2 && !currentDrawerId) {
      startNextRound(); 
    } 
    // 2. NEW: If a game is ALREADY running, tell the late joiner!
    else if (currentDrawerId && players[currentDrawerId]) {
      socket.emit('round_update', {
        drawerName: players[currentDrawerId].name,
        wordLength: currentWord.length
      });
    }
  });

  socket.on('start', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('start', data) });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;

    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      player.score += 10;
      if (players[currentDrawerId]) {
        players[currentDrawerId].score += 5;
      }
      
      broadcastPlayers(); 
      io.emit('chat_message', { sender: player.name, text: text, isGuess: true });
      
      setTimeout(startNextRound, 3000);
    } else {
      io.emit('chat_message', { sender: player.name, text: text, isGuess: false });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    broadcastPlayers(); 
    
    const remainingPlayers = Object.keys(players).length;
    
    // NEW: The "Zombie" Fix
    if (remainingPlayers < 2) {
      // If room empties out, completely reset the game state
      currentDrawerId = null;
      currentWord = "";
    } else if (socket.id === currentDrawerId) {
      // If the drawer left but people are still here, skip to the next person
      startNextRound(); 
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));