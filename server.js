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

// NEW: Load words cleanly from the external CSV file
const fs = require('fs');
const path = require('path');
const wordsCsvPath = path.join(__dirname, 'words.csv');

const wordList = fs.readFileSync(wordsCsvPath, 'utf8')
  .split(',') // Split by comma
  .map(w => w.trim()) // Remove any accidental spaces
  .filter(w => w.length > 0); // Ignore any empty entries
  

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

  io.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length, word: currentWord });
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
  
  // NEW: Let the drawer manually wipe the board for everyone!
  socket.on('clear_board', () => { if(socket.id === currentDrawerId) io.emit('clear_board') });
  
  // NEW: Sync paint bucket fills!
  socket.on('fill', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('fill', data) });
  
  // NEW: Sync Undo and Redo!
  socket.on('undo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('undo') });
  socket.on('redo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('redo') });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;
    
    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      clearInterval(timerInterval); 
      player.score += 10;
      if (players[currentDrawerId]) players[currentDrawerId].score += 5;
      
      broadcastPlayers(); 
      io.emit('chat_message', { sender: player.name, text: text, isGuess: true });
      
      // NEW: Tell all clients to play the "Ding!" sound!
      io.emit('correct_guess');
      
      // NEW: Check if this player just reached 100 points
      if (player.score >= 30) {
        io.emit('game_over', player.name);
        
        // Reset all scores to 0 for the next match
        Object.values(players).forEach(p => p.score = 0);
        
        // Wait 8 seconds for the celebration screen, then restart
        setTimeout(() => {
          broadcastPlayers();
          startNextRound();
        }, 8000); 
      } else {
        // Normal round progression
        setTimeout(startNextRound, 3000);
      }
    }
     else {
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