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
let currentRound = 1;
let drawQueue = [];      // Tracks who still needs to draw this round
let priorityQueue = [];  // Tracks late joiners who get to draw first next round

// Load words cleanly from the external CSV file
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

// --- NEW: Fair Round-Robin Turn System ---
function startNextTurn() {
  clearInterval(timerInterval); // Stop any old timers
  
  const playerIds = Object.keys(players);
  if (playerIds.length < 2) {
    currentDrawerId = null;
    currentWord = "";
    return;
  }

  // If everyone has drawn, the round is over!
  if (drawQueue.length === 0) {
    currentRound++;
    
    // Check if the standard 3-round match is finished
    if (currentRound > 3) {
      // Find the player with the highest score
      let winnerId = playerIds.reduce((a, b) => players[a].score > players[b].score ? a : b);
      io.emit('game_over', players[winnerId].name);
      
      // Reset scores and queues for a brand new match
      Object.values(players).forEach(p => p.score = 0);
      currentRound = 1;
      drawQueue = Object.keys(players); 
      priorityQueue = [];
      
      // Wait 8 seconds for the celebration screen, then restart
      setTimeout(() => {
        broadcastPlayers();
        startNextTurn();
      }, 8000); 
      return;
    } else {
      // It is round 2 or 3! Build the new draw queue.
      // Late joiners (priorityQueue) go first, then everyone else is added.
      drawQueue = [...priorityQueue];
      priorityQueue = [];
      playerIds.forEach(id => {
        if (!drawQueue.includes(id)) drawQueue.push(id);
      });
    }
  }

  // Pop the next person in line to be the drawer
  currentDrawerId = drawQueue.shift();
  
  // If they disconnected while waiting in queue, just skip to the next person
  if (!players[currentDrawerId]) {
    return startNextTurn(); 
  }

  currentWord = wordList[Math.floor(Math.random() * wordList.length)];
  timeRemaining = 60; // Set clock to 60 seconds

  io.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length, word: currentWord });
  io.emit('clear_board'); 
  io.to(currentDrawerId).emit('secret_word', currentWord);

  // --- The Ticking Clock ---
  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit('timer_update', timeRemaining); // Send tick to frontend

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      // Tell everyone the word if time runs out!
      io.emit('chat_message', { sender: "System", text: `Time's up! The word was: ${currentWord}`, isGuess: false });
      setTimeout(startNextTurn, 3000); 
    }
  }, 1000);
}

io.on('connection', (socket) => {
  socket.on('join_game', (playerName) => {
    players[socket.id] = { name: playerName, score: 0 };
    broadcastPlayers(); 

    if (Object.keys(players).length >= 2 && !currentDrawerId) {
      // Brand new game starting
      currentRound = 1;
      drawQueue = Object.keys(players);
      priorityQueue = [];
      startNextTurn(); 
    } else if (currentDrawerId && players[currentDrawerId]) {
      // Someone joined mid-game! Add them to the priority queue for next round.
      priorityQueue.push(socket.id);
      socket.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length, word: currentWord });
      socket.emit('timer_update', timeRemaining); // Give late joiners the current time
    }
  });

  socket.on('start', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('start', data) });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });
  
  // Let the drawer manually wipe the board for everyone!
  socket.on('clear_board', () => { if(socket.id === currentDrawerId) io.emit('clear_board') });
  
  // Sync paint bucket fills!
  socket.on('fill', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('fill', data) });
  
  // Sync Undo and Redo!
  socket.on('undo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('undo') });
  socket.on('redo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('redo') });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;
    
    // FIX: Hard-block the drawer from sending ANY chat messages to the server to prevent cheating!
    if (socket.id === currentDrawerId) return;
    
    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      clearInterval(timerInterval); 
      player.score += 10;
      if (players[currentDrawerId]) players[currentDrawerId].score += 5;
      
      broadcastPlayers(); 
      io.emit('chat_message', { sender: player.name, text: text, isGuess: true });
      
      // Tell all clients to play the "Ding!" sound!
      io.emit('correct_guess');
      
      // Move to the next turn immediately (game over check is now handled in startNextTurn)
      setTimeout(startNextTurn, 3000);
    } else {
      io.emit('chat_message', { sender: player.name, text: text, isGuess: false });
    }
  });

  socket.on('disconnect', () => {
    delete players[socket.id];
    
    // Remove them from queues if they leave
    drawQueue = drawQueue.filter(id => id !== socket.id);
    priorityQueue = priorityQueue.filter(id => id !== socket.id);
    
    broadcastPlayers(); 
    
    if (Object.keys(players).length < 2) {
      clearInterval(timerInterval);
      currentDrawerId = null;
      currentWord = "";
    } else if (socket.id === currentDrawerId) {
      clearInterval(timerInterval);
      startNextTurn(); 
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));