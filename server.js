const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

const PUBLIC_MAX_PLAYERS = 8;
let roomCounter = 1;
const rooms = {}; 

const fs = require('fs');
const path = require('path');
const wordsCsvPath = path.join(__dirname, 'words.csv');

const wordList = fs.readFileSync(wordsCsvPath, 'utf8')
  .split(',') 
  .map(w => w.trim()) 
  .filter(w => w.length > 0); 

// --- NEW: Room Generators with Hint Level ---
function getOrCreatePublicRoom() {
  for (const roomId in rooms) {
    if (!rooms[roomId].isPrivate && Object.keys(rooms[roomId].players).length < PUBLIC_MAX_PLAYERS) {
      return roomId;
    }
  }
  const newRoomId = `public_${roomCounter++}`;
  // Public lobbies automatically default to hint level 2 (Normal)
  rooms[newRoomId] = createRoomObject(newRoomId, false, null, PUBLIC_MAX_PLAYERS, 3, 120, null, 2);
  return newRoomId;
}

function createPrivateRoom(hostId, settings) {
  const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[newRoomId] = createRoomObject(
    newRoomId, 
    true, 
    hostId, 
    parseInt(settings.maxPlayers) || 8, 
    parseInt(settings.rounds) || 3, 
    parseInt(settings.drawTime) || 120,
    settings.customWords,
    parseInt(settings.hintLevel) || 2 // FIX: Extract the hint setting!
  );
  return newRoomId;
}

function createRoomObject(id, isPrivate, hostId, maxPlayers, maxRounds, drawTime, customWords = null, hintLevel = 2) {
  return {
    id, isPrivate, hostId, maxPlayers, maxRounds, drawTime,
    customWords, hintLevel, // FIX: Store it in the room object!
    players: {}, currentWord: "", currentDrawerId: null,
    gameState: 'waiting', timeRemaining: 0, timerInterval: null,
    afkTimeout: null, currentRound: 1, drawQueue: [], priorityQueue: [], activeVotes: {}
  };
}

function broadcastPlayers(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('update_players', Object.values(room.players));
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

function startNextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  clearInterval(room.timerInterval); 
  clearTimeout(room.afkTimeout); 
  
  const playerIds = Object.keys(room.players);
  if (playerIds.length < 2) {
    room.gameState = 'waiting';
    room.currentDrawerId = null;
    room.currentWord = "";
    io.to(roomId).emit('waiting_for_players');
    return;
  }

  if (room.drawQueue.length === 0) {
    room.currentRound++;
    if (room.currentRound > room.maxRounds) {
      room.gameState = 'waiting';
      let winnerId = playerIds.reduce((a, b) => room.players[a].score > room.players[b].score ? a : b);
      io.to(roomId).emit('game_over', room.players[winnerId].name);
      
      Object.values(room.players).forEach(p => p.score = 0);
      room.currentRound = 1;
      room.drawQueue = Object.keys(room.players); 
      room.priorityQueue = [];
      
      setTimeout(() => {
        broadcastPlayers(roomId);
        if (room.isPrivate) {
          io.to(roomId).emit('waiting_for_host');
        } else {
          startNextTurn(roomId);
        }
      }, 8000); 
      return;
    } else {
      room.drawQueue = [...room.priorityQueue];
      room.priorityQueue = [];
      playerIds.forEach(id => {
        if (!room.drawQueue.includes(id)) room.drawQueue.push(id);
      });
    }
  }

  room.currentDrawerId = room.drawQueue.shift();
  if (!room.players[room.currentDrawerId]) {
    return startNextTurn(roomId); 
  }

  room.gameState = 'choosing';
  room.timeRemaining = 15; 
  
  let choices = [];
  let tempWords = (room.customWords && room.customWords.length > 0) ? [...room.customWords] : [...wordList];
  
  for (let i = 0; i < 5; i++) {
    if (tempWords.length === 0) tempWords = [...wordList]; 
    
    const randIndex = Math.floor(Math.random() * tempWords.length);
    choices.push(tempWords.splice(randIndex, 1)[0]);
  }

  io.to(roomId).emit('clear_board');
  io.to(roomId).emit('choosing_word', { drawerName: room.players[room.currentDrawerId].name });
  io.to(room.currentDrawerId).emit('your_word_choices', choices);

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    io.to(roomId).emit('timer_update', room.timeRemaining); 

    if (room.timeRemaining <= 0) {
      startDrawingPhase(roomId, choices[0]);
    }
  }, 1000);
}

function startDrawingPhase(roomId, selectedWord) {
  const room = rooms[roomId];
  if (!room) return;

  clearInterval(room.timerInterval);
  clearTimeout(room.afkTimeout);
  
  room.gameState = 'drawing';
  room.currentWord = selectedWord;
  room.timeRemaining = room.drawTime; 

  // FIX: Include hintLevel in the round update
  io.to(roomId).emit('round_update', { drawerName: room.players[room.currentDrawerId].name, wordLength: room.currentWord.length, word: room.currentWord, currentRound: room.currentRound, maxRounds: room.maxRounds, hintLevel: room.hintLevel });
  io.to(room.currentDrawerId).emit('secret_word', room.currentWord);

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    io.to(roomId).emit('timer_update', room.timeRemaining); 

    if (room.timeRemaining <= 0) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout); 
      io.to(roomId).emit('chat_message', { sender: "System", text: `Time's up! The word was: ${room.currentWord}`, isGuess: false });
      setTimeout(() => startNextTurn(roomId), 3000); 
    }
  }, 1000);

  room.afkTimeout = setTimeout(() => {
    clearInterval(room.timerInterval); 
    io.to(roomId).emit('chat_message', { sender: "System", text: `Drawer is AFK! Skipping turn...`, isGuess: false });
    startNextTurn(roomId); 
  }, 60000);  // 10 sec = 10000 , 1 sec = 1000 
}

io.on('connection', (socket) => {
  socket.on('join_game', (data) => {
    const playerName = typeof data === 'string' ? data : data.playerName;
    const requestedRoomId = data.roomId;
    const privateSettings = data.privateSettings;

    let roomId;

    if (privateSettings) {
      roomId = createPrivateRoom(socket.id, privateSettings);
    } else if (requestedRoomId) {
      if (!rooms[requestedRoomId]) {
        return socket.emit('room_error', "This room does not exist or has expired.");
      }
      roomId = requestedRoomId;
    } else {
      roomId = getOrCreatePublicRoom();
    }

    const room = rooms[roomId];

    if (Object.keys(room.players).length >= room.maxPlayers) {
      return socket.emit('room_error', "This room is currently full.");
    }

    socket.join(roomId);
    socket.roomId = roomId; 
    room.players[socket.id] = { id: socket.id, name: playerName, score: 0 };
    
    // FIX: Include hintLevel in the initial join metadata
    socket.emit('room_joined', { 
      roomId: room.id, 
      isPrivate: room.isPrivate, 
      isHost: room.hostId === socket.id,
      maxRounds: room.maxRounds,
      drawTime: room.drawTime,
      hintLevel: room.hintLevel
    });

    broadcastPlayers(roomId); 
    io.to(roomId).emit('chat_message', { sender: "System", text: `${playerName} joined the lobby. (${Object.keys(room.players).length}/${room.maxPlayers})`, isGuess: false });

    if (!room.isPrivate) {
      if (Object.keys(room.players).length >= 2 && !room.currentDrawerId) {
        room.currentRound = 1;
        room.drawQueue = Object.keys(room.players);
        room.priorityQueue = [];
        startNextTurn(roomId); 
      } else if (room.currentDrawerId && room.players[room.currentDrawerId]) {
        syncLateJoiner(socket, room);
      }
    } else {
      if (room.gameState === 'waiting') {
        socket.emit('waiting_for_host');
      } else {
        syncLateJoiner(socket, room);
      }
    }
  });

  function syncLateJoiner(socket, room) {
    room.priorityQueue.push(socket.id);
    if (room.gameState === 'choosing') {
      socket.emit('choosing_word', { drawerName: room.players[room.currentDrawerId].name });
    } else if (room.gameState === 'drawing') {
      // FIX: Include hintLevel for late joiners!
      socket.emit('round_update', { drawerName: room.players[room.currentDrawerId].name, wordLength: room.currentWord.length, word: room.currentWord, currentRound: room.currentRound, maxRounds: room.maxRounds, hintLevel: room.hintLevel });
      io.to(room.currentDrawerId).emit('request_canvas_state', socket.id);
    }
    socket.emit('timer_update', room.timeRemaining); 
  }

  socket.on('start_private_game', () => {
    const room = rooms[socket.roomId];
    if (room && room.isPrivate && room.hostId === socket.id && Object.keys(room.players).length >= 2) {
      room.currentRound = 1;
      room.drawQueue = Object.keys(room.players);
      room.priorityQueue = [];
      startNextTurn(room.id);
    }
  });

  socket.on('word_chosen', (word) => {
    const room = rooms[socket.roomId];
    if (room && socket.id === room.currentDrawerId && room.gameState === 'choosing') {
      startDrawingPhase(room.id, word);
    }
  });

  const cancelAfk = (room) => { if (room && socket.id === room.currentDrawerId && room.gameState === 'drawing') clearTimeout(room.afkTimeout); };

  socket.on('start', (data) => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) { cancelAfk(room); socket.to(room.id).emit('start', data); } });
  socket.on('draw', (data) => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('draw', data) });
  socket.on('stop', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('stop') });
  
  socket.on('clear_board', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) { cancelAfk(room); io.to(room.id).emit('clear_board'); } });
  socket.on('fill', (data) => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) { cancelAfk(room); socket.to(room.id).emit('fill', data); } });
  
  socket.on('undo', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('undo') });
  socket.on('redo', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('redo') });
  
  socket.on('send_canvas_state', ({ targetId, canvasData }) => {
    io.to(targetId).emit('load_canvas_state', canvasData);
  });
  
  socket.on('initiate_votekick', (targetId) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    
    if (room.isPrivate && room.hostId === targetId) {
       return socket.emit('chat_message', { sender: "System", text: `You cannot vote kick the room host.`, isGuess: false });
    }
    
    const initiator = room.players[socket.id];
    const target = room.players[targetId];
    if (!initiator || !target || room.activeVotes[targetId]) return;

    room.activeVotes[targetId] = {
      yes: new Set([socket.id]), 
      no: new Set(),
      targetName: target.name,
      initiatorName: initiator.name
    };

    io.to(room.id).emit('chat_message', {
      type: 'votekick',
      targetId: targetId,
      targetName: target.name,
      initiatorName: initiator.name,
      text: `${initiator.name} has voted to kick ${target.name}. Do you wish to kick this player from the lobby?`
    });

    setTimeout(() => {
      if (room.activeVotes && room.activeVotes[targetId]) {
        io.to(room.id).emit('chat_message', { sender: "System", text: `Vote to kick ${target.name} expired.`, isGuess: false });
        delete room.activeVotes[targetId];
      }
    }, 60000);
  });

  socket.on('submit_votekick', (data) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    
    const { targetId, vote } = data; 
    const voteSession = room.activeVotes[targetId];
    if (!voteSession || !room.players[socket.id]) return;

    if (vote === 'yes') voteSession.yes.add(socket.id);
    else voteSession.no.add(socket.id);

    const totalPlayers = Object.keys(room.players).length;
    const requiredVotes = Math.floor(totalPlayers / 2) + 1; 

    if (voteSession.yes.size >= requiredVotes) {
      io.to(room.id).emit('chat_message', { sender: "System", text: `${voteSession.targetName} was kicked from the lobby.`, isGuess: false });
      
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) {
        targetSocket.emit('kicked_from_server');
        targetSocket.disconnect(true);
      }
      delete room.activeVotes[targetId];
    } else if (voteSession.no.size >= requiredVotes || (voteSession.yes.size + voteSession.no.size === totalPlayers)) {
      io.to(room.id).emit('chat_message', { sender: "System", text: `Vote to kick ${voteSession.targetName} failed.`, isGuess: false });
      delete room.activeVotes[targetId];
    }
  });

  socket.on('chat_message', (text) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    
    const player = room.players[socket.id];
    if (!player) return;
    if (socket.id === room.currentDrawerId) return;
    
    if (room.gameState === 'drawing' && room.currentWord && text.trim().toLowerCase() === room.currentWord.toLowerCase()) {
      clearInterval(room.timerInterval); 
      clearTimeout(room.afkTimeout); 
      
      player.score += 10;
      if (room.players[room.currentDrawerId]) room.players[room.currentDrawerId].score += 5;
      
      broadcastPlayers(room.id); 
      io.to(room.id).emit('chat_message', { sender: player.name, text: text, isGuess: true });
      io.to(room.id).emit('correct_guess');
      
      setTimeout(() => startNextTurn(room.id), 3000);
    } else {
      io.to(room.id).emit('chat_message', { sender: player.name, text: text, isGuess: false });
      
      if (room.gameState === 'drawing' && room.currentWord && room.currentWord.length > 2) {
        const guess = text.trim().toLowerCase();
        const target = room.currentWord.toLowerCase();
        
        if (Math.abs(guess.length - target.length) <= 2) {
          const typos = getEditDistance(guess, target);
          if (typos === 1 || (typos === 2 && target.length >= 5)) {
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
    const room = rooms[socket.roomId];
    if (!room) return;

    delete room.players[socket.id];
    room.drawQueue = room.drawQueue.filter(id => id !== socket.id);
    room.priorityQueue = room.priorityQueue.filter(id => id !== socket.id);
    
    if (room.isPrivate && socket.id === room.hostId) {
      const remainingIds = Object.keys(room.players);
      if (remainingIds.length > 0) {
        room.hostId = remainingIds[0];
        // FIX: Ensure the new host also gets the hint level data so their UI doesn't break
        io.to(room.hostId).emit('room_joined', { roomId: room.id, isPrivate: true, isHost: true, maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel });
      }
    }

    if (Object.keys(room.players).length === 0) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout);
      delete rooms[socket.roomId];
      return;
    }

    broadcastPlayers(room.id); 
    
    if (Object.keys(room.players).length < 2) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout); 
      room.gameState = 'waiting';
      room.currentDrawerId = null;
      room.currentWord = "";
      if (room.isPrivate) {
         io.to(room.id).emit('waiting_for_host');
      } else {
         io.to(room.id).emit('waiting_for_players');
      }
    } else if (socket.id === room.currentDrawerId) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout); 
      startNextTurn(room.id); 
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));