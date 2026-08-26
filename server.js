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

// --- NEW: Turn and Round Tracking ---
let timeRemaining = 0;
let timerInterval = null; 
let afkTimeout = null; // NEW: Tracks if the drawer is AFK
let currentRound = 1;
let drawQueue = [];      
let priorityQueue = [];  

// Load words cleanly from the external CSV file
const fs = require('fs');
const path = require('path');
const wordsCsvPath = path.join(__dirname, 'words.csv');

const wordList = fs.readFileSync(wordsCsvPath, 'utf8')
  .split(',') 
  .map(w => w.trim()) 
  .filter(w => w.length > 0); 

function broadcastPlayers() {
  io.emit('update_players', Object.values(players));
}

function getEditDistance(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) { matrix[i] = [i]; }
  for (let j = 0; j <= a.length; j++) { matrix[0][j] = j; }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, Math.min(matrix[i][j - 1] + 1, matrix[i - 1][j] + 1));
      }
    }
  }
  return matrix[b.length][a.length];
}

function startNextTurn() {
  clearInterval(timerInterval); 
  clearTimeout(afkTimeout); // Clear old AFK penalty timer
  
  const playerIds = Object.keys(players);
  if (playerIds.length < 2) {
    currentDrawerId = null;
    currentWord = "";
    return;
  }

  if (drawQueue.length === 0) {
    currentRound++;
    if (currentRound > 3) {
      let winnerId = playerIds.reduce((a, b) => players[a].score > players[b].score ? a : b);
      io.emit('game_over', players[winnerId].name);
      Object.values(players).forEach(p => p.score = 0);
      currentRound = 1;
      drawQueue = Object.keys(players); 
      priorityQueue = [];
      setTimeout(() => {
        broadcastPlayers();
        startNextTurn();
      }, 8000); 
      return;
    } else {
      drawQueue = [...priorityQueue];
      priorityQueue = [];
      playerIds.forEach(id => {
        if (!drawQueue.includes(id)) drawQueue.push(id);
      });
    }
  }

  currentDrawerId = drawQueue.shift();
  if (!players[currentDrawerId]) {
    return startNextTurn(); 
  }

  currentWord = wordList[Math.floor(Math.random() * wordList.length)];
  timeRemaining = 120; // FIX: Increased to 120 seconds for public lobbies 

  io.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length, word: currentWord, currentRound });
  io.emit('clear_board'); 
  io.to(currentDrawerId).emit('secret_word', currentWord);

  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit('timer_update', timeRemaining); 

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      clearTimeout(afkTimeout); // Clean up
      io.emit('chat_message', { sender: "System", text: `Time's up! The word was: ${currentWord}`, isGuess: false });
      setTimeout(startNextTurn, 3000); 
    }
  }, 1000);

  // --- NEW: The 15-Second AFK Penalty ---
  afkTimeout = setTimeout(() => {
    clearInterval(timerInterval); // Stop the main round clock
    io.emit('chat_message', { sender: "System", text: `Drawer is AFK! Skipping turn...`, isGuess: false });
    startNextTurn(); 
  }, 30000); // FIX: Increased AFK penalty to 30 seconds
}

io.on('connection', (socket) => {
  socket.on('join_game', (playerName) => {
    players[socket.id] = { name: playerName, score: 0 };
    broadcastPlayers(); 

    if (Object.keys(players).length >= 2 && !currentDrawerId) {
      currentRound = 1;
      drawQueue = Object.keys(players);
      priorityQueue = [];
      startNextTurn(); 
    } else if (currentDrawerId && players[currentDrawerId]) {
      priorityQueue.push(socket.id);
      socket.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length, word: currentWord, currentRound });
      socket.emit('timer_update', timeRemaining); 
    }
  });

  // NEW: Helper to cancel the AFK penalty the moment they touch the canvas
  const cancelAfk = () => { if (socket.id === currentDrawerId) clearTimeout(afkTimeout); };

  socket.on('start', (data) => { if(socket.id === currentDrawerId) { cancelAfk(); socket.broadcast.emit('start', data); } });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });
  
  // They hit clear or fill? They are actively playing! Cancel the AFK.
  socket.on('clear_board', () => { if(socket.id === currentDrawerId) { cancelAfk(); io.emit('clear_board'); } });
  socket.on('fill', (data) => { if(socket.id === currentDrawerId) { cancelAfk(); socket.broadcast.emit('fill', data); } });
  
  socket.on('undo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('undo') });
  socket.on('redo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('redo') });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;
    
    if (socket.id === currentDrawerId) return;
    
    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      clearInterval(timerInterval); 
      clearTimeout(afkTimeout); // FIX: Don't accidentally AFK skip if someone guesses instantly!
      
      player.score += 10;
      if (players[currentDrawerId]) players[currentDrawerId].score += 5;
      
      broadcastPlayers(); 
      io.emit('chat_message', { sender: player.name, text: text, isGuess: true });
      io.emit('correct_guess');
      
      setTimeout(startNextTurn, 3000);
    } else {
      io.emit('chat_message', { sender: player.name, text: text, isGuess: false });
      
      if (currentWord && currentWord.length > 2) {
        const guess = text.trim().toLowerCase();
        const target = currentWord.toLowerCase();
        
        if (Math.abs(guess.length - target.length) <= 2) {
          const typos = getEditDistance(guess, target);
          if (typos === 1 || (typos === 2 && target.length >= 5)) {
            socket.emit('chat_message', { 
              sender: "System", 
              text: `'${text}' is very close! Keep trying!`, 
              isGuess: false 
            });
          }
        }
      }
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    drawQueue = drawQueue.filter(id => id !== socket.id);
    priorityQueue = priorityQueue.filter(id => id !== socket.id);
    
    broadcastPlayers(); 
    
    if (Object.keys(players).length < 2) {
      clearInterval(timerInterval);
      clearTimeout(afkTimeout); // Clean up
      currentDrawerId = null;
      currentWord = "";
    } else if (socket.id === currentDrawerId) {
      clearInterval(timerInterval);
      clearTimeout(afkTimeout); // Clean up
      startNextTurn(); 
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));