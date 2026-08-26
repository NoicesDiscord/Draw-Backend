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

// --- Timers and States ---
let timeRemaining = 0;
let timerInterval = null; 
let afkTimeout = null; 
let currentRound = 1;
let drawQueue = [];      
let priorityQueue = [];  
let activeVotes = {}; // NEW: Tracks active kick votes

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
  clearTimeout(afkTimeout); 
  
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
  timeRemaining = 120; 

  io.emit('round_update', { drawerName: players[currentDrawerId].name, wordLength: currentWord.length, word: currentWord, currentRound });
  io.emit('clear_board'); 
  io.to(currentDrawerId).emit('secret_word', currentWord);

  timerInterval = setInterval(() => {
    timeRemaining--;
    io.emit('timer_update', timeRemaining); 

    if (timeRemaining <= 0) {
      clearInterval(timerInterval);
      clearTimeout(afkTimeout); 
      io.emit('chat_message', { sender: "System", text: `Time's up! The word was: ${currentWord}`, isGuess: false });
      setTimeout(startNextTurn, 3000); 
    }
  }, 1000);

  // FIX: Increased AFK Penalty to 40 seconds!
  afkTimeout = setTimeout(() => {
    clearInterval(timerInterval); 
    io.emit('chat_message', { sender: "System", text: `Drawer is AFK! Skipping turn...`, isGuess: false });
    startNextTurn(); 
  }, 40000); 
}

io.on('connection', (socket) => {
  socket.on('join_game', (playerName) => {
    // FIX: Attach the socket.id to the player object so we can target them for kicks!
    players[socket.id] = { id: socket.id, name: playerName, score: 0 };
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

  const cancelAfk = () => { if (socket.id === currentDrawerId) clearTimeout(afkTimeout); };

  socket.on('start', (data) => { if(socket.id === currentDrawerId) { cancelAfk(); socket.broadcast.emit('start', data); } });
  socket.on('draw', (data) => { if(socket.id === currentDrawerId) socket.broadcast.emit('draw', data) });
  socket.on('stop', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('stop') });
  
  socket.on('clear_board', () => { if(socket.id === currentDrawerId) { cancelAfk(); io.emit('clear_board'); } });
  socket.on('fill', (data) => { if(socket.id === currentDrawerId) { cancelAfk(); socket.broadcast.emit('fill', data); } });
  
  socket.on('undo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('undo') });
  socket.on('redo', () => { if(socket.id === currentDrawerId) socket.broadcast.emit('redo') });

  // --- NEW: Vote Kick Logic ---
  socket.on('initiate_votekick', (targetId) => {
    const initiator = players[socket.id];
    const target = players[targetId];
    if (!initiator || !target || activeVotes[targetId]) return;

    activeVotes[targetId] = {
      yes: new Set([socket.id]), // The person starting the vote automatically votes YES
      no: new Set(),
      targetName: target.name,
      initiatorName: initiator.name
    };

    io.emit('chat_message', {
      type: 'votekick',
      targetId: targetId,
      targetName: target.name,
      initiatorName: initiator.name,
      text: `${initiator.name} has voted to kick ${target.name}. Do you wish to kick this player from the lobby?`
    });

    // Votes expire after 60 seconds if inconclusive
    setTimeout(() => {
      if (activeVotes[targetId]) {
        io.emit('chat_message', { sender: "System", text: `Vote to kick ${target.name} expired.`, isGuess: false });
        delete activeVotes[targetId];
      }
    }, 60000);
  });

  socket.on('submit_votekick', (data) => {
    const { targetId, vote } = data; 
    const voteSession = activeVotes[targetId];
    if (!voteSession || !players[socket.id]) return;

    if (vote === 'yes') voteSession.yes.add(socket.id);
    else voteSession.no.add(socket.id);

    const totalPlayers = Object.keys(players).length;
    const requiredVotes = Math.floor(totalPlayers / 2) + 1; // Strict majority (> 50%)

    if (voteSession.yes.size >= requiredVotes) {
      io.emit('chat_message', { sender: "System", text: `${voteSession.targetName} was kicked from the lobby.`, isGuess: false });
      
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.emit('kicked_from_server');
        targetSocket.disconnect(true);
      }
      delete activeVotes[targetId];
    } else if (voteSession.no.size >= requiredVotes || (voteSession.yes.size + voteSession.no.size === totalPlayers)) {
      io.emit('chat_message', { sender: "System", text: `Vote to kick ${voteSession.targetName} failed.`, isGuess: false });
      delete activeVotes[targetId];
    }
  });

  socket.on('chat_message', (text) => {
    const player = players[socket.id];
    if (!player) return;
    if (socket.id === currentDrawerId) return;
    
    if (currentWord && text.trim().toLowerCase() === currentWord.toLowerCase()) {
      clearInterval(timerInterval); 
      clearTimeout(afkTimeout); 
      
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
            // FIX: Added the bulb emoji and a custom 'isCloseGuess' flag!
            socket.emit('chat_message', { 
              sender: "System", 
              text: `'${text}' is very close! Keep trying! 💡`, 
              isGuess: false,
              isCloseGuess: true
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
      clearTimeout(afkTimeout); 
      currentDrawerId = null;
      currentWord = "";
      // FIX: Tell the remaining player to go back to the waiting screen!
      io.emit('waiting_for_players');
    } else if (socket.id === currentDrawerId) {
      clearInterval(timerInterval);
      clearTimeout(afkTimeout); 
      startNextTurn(); 
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));