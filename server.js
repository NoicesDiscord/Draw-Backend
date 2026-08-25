const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let players = {}; 
let currentWord = "";
let currentDrawerId = null;

// --- NEW: Timer States ---
let timeRemaining = 0;
let timerInterval = null; 

const wordList = ["apple", "house", "car", "dog", "sun", "pizza", "mountain", "ocean", "guitar", "robot"];

function broadcastPlayers() {
  io.emit('update_players', Object.values(players));
}

function startNextRound() {
  clearInterval(timerInterval); // Stop any old timers
  
  const playerIds = Object.keys(players);
  if (playerIds.length < 2) {
    currentDrawerId = null;
    currentWord = "";
    return;
  }

  currentDrawerId = playerIds[Math.floor(Math.random() * playerIds.length)];
  currentWord = wordList[Math.floor(Math.random() * wordList.length)];
  timeRemaining = 60; // Set clock to 60 seconds

  io.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length });
  io.emit('clear_board'); 
  io.to(currentDrawerId).emit('secret_word', currentWord);

  // --- NEW: The Ticking Clock ---
  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit('timer_update', timeRemaining); // Send tick to frontend

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      // Tell everyone the word if time runs out!
      io.emit('chat_message', { sender: "System", text: `Time's up! The word was: ${currentWord}`, isGuess: false });
      setTimeout(startNextRound, 3000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.on('join_game', (playerName) => {
    players[socket.id] = { name: playerName, score: 0 };
    broadcastPlayers(); 

    if (Object.keys(players).length >= 2 && !currentDrawerId) {
      startNextRound(); 
    } else if (currentDrawerId && players[currentDrawerId]) {
      socket.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length });
      socket.emit('timer_update', timeRemaining); // Give late joiners the current time
    }
  });

  socket.on('start', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('start', data) });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;

    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      clearInterval(timerInterval); // Stop clock on correct guess!
      player.score += 10;
      if (players[currentDrawerId]) players[currentDrawerId].score += 5;
      
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
    
    if (Object.keys(players).length < 2) {
      clearInterval(timerInterval);
      currentDrawerId = null;
      currentWord = "";
    } else if (socket.id === currentDrawerId) {
      clearInterval(timerInterval);
      startNextRound(); 
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));