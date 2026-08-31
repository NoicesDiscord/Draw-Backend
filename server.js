const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
 
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- NEW: API Route for Browsing Lobbies ---
app.get('/api/rooms', (req, res) => {
  const customRooms = Object.values(rooms)
    .filter(r => r.isPrivate)
    .map(r => ({
      id: r.id,
      hostName: r.players[r.hostId] ? r.players[r.hostId].name : 'Unknown Host',
      players: Object.keys(r.players).length,
      maxPlayers: r.maxPlayers,
      hasPassword: !!r.password // Only tells frontend IF there is a password, doesn't reveal it!
    }));
  res.json(customRooms);
});

// --- NEW: API Route for Instant Password Validation ---
app.get('/api/validate-password', (req, res) => {
  const { roomId, password } = req.query;
  const room = rooms[roomId];
  if (!room) return res.json({ success: false, message: "This room does not exist or has expired." });
  if (room.isPrivate && room.password && room.password !== password) {
    return res.json({ success: false, message: "Incorrect room password." });
  }
  res.json({ success: true });
});

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
  // Public lobbies automatically default to hint level 3 (High)
  rooms[newRoomId] = createRoomObject(newRoomId, false, null, PUBLIC_MAX_PLAYERS, 3, 120, null, 3);
  return newRoomId;
}

function createPrivateRoom(hostId, settings) {
  // FIX: Protect the server from DDOS! Strips out any maliciously injected words 
  // over 50 characters so the getEditDistance algorithm doesn't freeze the backend CPU.
  const safeCustomWords = Array.isArray(settings.customWords) 
    ? settings.customWords.filter(w => typeof w === 'string' && w.length <= 50) 
    : null;

  const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
  rooms[newRoomId] = createRoomObject(
    newRoomId, 
    true, 
    hostId, 
    Math.max(2, Math.min(8, parseInt(settings.maxPlayers) || 8)), 
    Math.max(1, Math.min(10, parseInt(settings.rounds) || 3)), 
    Math.max(30, Math.min(300, parseInt(settings.drawTime) || 120)),
    safeCustomWords, // Insert the sanitized array here!
    Math.max(1, Math.min(4, parseInt(settings.hintLevel) || 2)),
    settings.password || null
  );
  return newRoomId;
}

function createRoomObject(id, isPrivate, hostId, maxPlayers, maxRounds, drawTime, customWords = null, hintLevel = 2, password = null) {
  return {
    id, isPrivate, hostId, maxPlayers, maxRounds, drawTime, hintLevel, password,
    players: {}, currentWord: "", currentDrawerId: null,
    gameState: 'waiting', timeRemaining: 0, timerInterval: null,
    afkTimeout: null, currentRound: 1, drawQueue: [], priorityQueue: [], activeVotes: {},
    correctGuessers: [], turnScores: {}, underdogs: [],
    customWords: customWords, // FIX: Save custom words to the room state to refill later!
    // FIX: Merges custom words WITH the base wordList instead of replacing it!
    availableWords: customWords && customWords.length > 0 ? [...customWords, ...wordList] : [...wordList]
  };
}

function broadcastPlayers(roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('update_players', Object.values(room.players));
}
// --- NEW: Secure Server-Side Hint Engine ---
function getRevealedChars(room) {
  if (!room.currentWord || !room.hintOrder) return {};
  const totalLetters = (room.currentWord.match(/[a-zA-Z0-9]/g) || []).length;
  let dynamicMaxHints = 0;
  if (totalLetters > 2) {
    if (room.hintLevel == 1) dynamicMaxHints = Math.floor(totalLetters * 0.40);
    if (room.hintLevel == 2) dynamicMaxHints = Math.floor(totalLetters * 0.50);
    if (room.hintLevel == 3) dynamicMaxHints = Math.floor(totalLetters * 0.60);
    if (room.hintLevel == 4) dynamicMaxHints = Math.floor(totalLetters * 0.70);
    if (dynamicMaxHints >= totalLetters) dynamicMaxHints = totalLetters - 1;
    if (dynamicMaxHints < 0) dynamicMaxHints = 0;
  }
  const cappedIndices = room.hintOrder.slice(0, dynamicMaxHints);
  let revealCount = 0;
  if (dynamicMaxHints > 0 && room.timeRemaining > 0 && room.timeRemaining <= room.drawTime) {
    const timeElapsed = room.drawTime - Math.min(room.timeRemaining, room.drawTime);
    const effectiveProgress = Math.max(0, (timeElapsed - (room.drawTime * 0.15)) / (room.drawTime * 0.85));
    revealCount = Math.floor(effectiveProgress * (dynamicMaxHints + 1));
    revealCount = Math.min(dynamicMaxHints, revealCount);
  }
  const revealedChars = {};
  cappedIndices.slice(0, revealCount).forEach(idx => {
     revealedChars[idx] = room.currentWord[idx].toUpperCase(); // Only hands out the exact letters!
  });
  return revealedChars;
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
      room.gameState = 'game_over'; // Pauses the game loop
      
      // NEW: Generate a sorted array of all players and their final scores
      const finalStandings = playerIds
        .map(id => ({ name: room.players[id].name, score: room.players[id].score }))
        .sort((a, b) => b.score - a.score);
      
      // Send the full stats array to the frontend
      io.to(roomId).emit('game_over', finalStandings);
      
      // Notice we removed the setTimeout! The server now waits for the host to click "Proceed"
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
  
  for (let i = 0; i < 5; i++) {
      // FIX: Refill the bucket securely with both custom words AND the base wordList!
      if (room.availableWords.length === 0) {
        room.availableWords = (room.customWords && room.customWords.length > 0) ? [...room.customWords, ...wordList] : [...wordList];
      }
      
      const randIndex = Math.floor(Math.random() * room.availableWords.length);
    // Splice permanently removes the word from the available list so it can't repeat in this lobby!
    choices.push(room.availableWords.splice(randIndex, 1)[0]);
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
  room.correctGuessers = []; 
  
  // NEW: Calculate Underdogs based on Late Joiners!
  // Find the 3rd highest score in the lobby to balance the OP buff
  const allScores = Object.values(room.players).map(p => p.score).sort((a, b) => b - a);
  const thirdHighestScore = allScores.length > 2 ? allScores[2] : (allScores[allScores.length - 1] || 0);

  // A player gets the buff if they joined Round 2 or later, AND their score is not close to 3rd place yet.
  // We define "close" as being at least 100 points behind the 3rd highest score.
  room.underdogs = Object.keys(room.players).filter(id => {
    const p = room.players[id];
    const isLateJoiner = p.joinedAtRound >= 2; 
    const isCatchingUp = p.score < (thirdHighestScore - 100);
    return isLateJoiner && isCatchingUp && id !== room.currentDrawerId;
  });

  room.turnScores = {};
  room.turnVoters = new Set(); 
  Object.keys(room.players).forEach(id => room.turnScores[id] = 0);

  // --- NEW: Generate Shared Hint Order for ALL Players ---
  const words = [];
  const wordStartIndices = [];
  let currentWord = "";
  let currentStart = -1;
  
  // Smart parsing: Separates letters/numbers from special characters
  for (let i = 0; i < selectedWord.length; i++) {
    if (/[a-zA-Z0-9]/.test(selectedWord[i])) {
      if (currentWord === "") currentStart = i;
      currentWord += selectedWord[i];
    } else {
      if (currentWord !== "") {
        words.push(currentWord);
        wordStartIndices.push(currentStart);
        currentWord = "";
      }
    }
  }
  if (currentWord !== "") {
    words.push(currentWord);
    wordStartIndices.push(currentStart);
  }
  
  // Shuffle letters for each word independently
  const wordPriorities = words.map(w => {
    let indices = Array.from({ length: w.length }, (_, i) => i);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    return indices;
  });
  
  const maxLength = words.length > 0 ? Math.max(...words.map(w => w.length)) : 0;
  let allowedIndices = [];
  
  // Round-Robin Distribution (Only runs on valid letters/numbers)
  for (let p = 0; p < maxLength; p++) {
    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      if (p < wordPriorities[wIdx].length) {
        allowedIndices.push(wordStartIndices[wIdx] + wordPriorities[wIdx][p]);
      }
    }
  }
  room.hintOrder = allowedIndices; // Save it to the room object

  // --- NEW: Generate Secure Word Skeleton for Guessers ---
  const skeleton = [];
  if (selectedWord) {
    let currentBlock = { isWord: /[a-zA-Z0-9]/.test(selectedWord[0]), text: selectedWord[0], length: 1 };
    for (let i = 1; i < selectedWord.length; i++) {
      const isAlpha = /[a-zA-Z0-9]/.test(selectedWord[i]);
      if (isAlpha === currentBlock.isWord) {
        currentBlock.text += selectedWord[i];
        currentBlock.length++;
      } else {
        skeleton.push(currentBlock.isWord ? { isWord: true, length: currentBlock.length } : { isWord: false, text: currentBlock.text });
        currentBlock = { isWord: isAlpha, text: selectedWord[i], length: 1 };
      }
    }
    skeleton.push(currentBlock.isWord ? { isWord: true, length: currentBlock.length } : { isWord: false, text: currentBlock.text });
  }
  room.skeleton = skeleton;

  // FIX: Remove 'word' from the broadcast so hackers can't see it in Dev Tools!
  io.to(roomId).emit('round_update', { 
    drawerName: room.players[room.currentDrawerId].name, 
    wordLength: room.currentWord.length, 
    skeleton: room.skeleton, // Send structure, not the word!
    currentRound: room.currentRound, 
    maxRounds: room.maxRounds, 
    hintLevel: room.hintLevel,
    underdogs: room.underdogs
  });
  
  io.to(room.currentDrawerId).emit('secret_word', room.currentWord); // Only the drawer gets this!

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    
    // Server now calculates the hints securely and sends them with the timer!
    io.to(roomId).emit('timer_update', { 
      time: room.timeRemaining, 
      revealedChars: getRevealedChars(room) 
    }); 

    if (room.timeRemaining <= 0) {
          clearInterval(room.timerInterval);
          clearTimeout(room.afkTimeout); 
          
          // NEW: Gather scores and emit the summary screen, then wait 4 seconds!
          const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
          io.to(roomId).emit('turn_summary', { word: room.currentWord, reason: "Time's up!", scores: summaryData });
          
          io.to(roomId).emit('chat_message', { sender: "System", text: `Time's up! The word was: ${room.currentWord}`, isGuess: false });
          setTimeout(() => startNextTurn(roomId), 4000); 
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
    if (!data) return; // FIX: Safe drop for null payloads
    const playerName = typeof data === 'string' ? data : (data.playerName || "Unknown");
    const requestedRoomId = data.roomId;
    const privateSettings = data.privateSettings;
    const providedPassword = data.password; // NEW
    const isBrowserJoin = data.isBrowserJoin; // NEW

    let roomId;

    if (privateSettings) {
      roomId = createPrivateRoom(socket.id, privateSettings);
    } else if (requestedRoomId) {
      const room = rooms[requestedRoomId];
      if (!room) {
        return socket.emit('room_error', "This room does not exist or has expired.");
      }
      
      // FIX: Demand a password for ALL private rooms that have one, even from invite links!
      if (room.isPrivate && room.password && room.password !== providedPassword) {
        return socket.emit('room_error', "Incorrect room password.");
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
    // NEW: Record the exact round this player joined!
    room.players[socket.id] = { id: socket.id, name: playerName, score: 0, joinedAtRound: room.currentRound || 1 };
    
    // --- NEW: Instantly calculate and broadcast Underdog buff for late joiners! ---
    const allScores = Object.values(room.players).map(p => p.score).sort((a, b) => b - a);
    const thirdHighestScore = allScores.length > 2 ? allScores[2] : (allScores[allScores.length - 1] || 0);

    room.underdogs = Object.keys(room.players).filter(id => {
      const p = room.players[id];
      const isLateJoiner = p.joinedAtRound >= 2; 
      const isCatchingUp = p.score < (thirdHighestScore - 100);
      return isLateJoiner && isCatchingUp && id !== room.currentDrawerId;
    });
    
    // Broadcast the new underdogs list immediately to everyone in the room!
    io.to(roomId).emit('update_underdogs', room.underdogs);
    
    // FIX: Include full room settings in the initial join metadata
    socket.emit('room_joined', { 
      roomId: room.id, 
      isPrivate: room.isPrivate, 
      isHost: room.hostId === socket.id,
      maxRounds: room.maxRounds,
      drawTime: room.drawTime,
      hintLevel: room.hintLevel,
      maxPlayers: room.maxPlayers,
      password: room.password // NEW: Let the frontend display the password in settings!
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
      socket.emit('round_update', { 
        drawerName: room.players[room.currentDrawerId].name, 
        wordLength: room.currentWord.length, 
        skeleton: room.skeleton, // Send secure skeleton
        currentRound: room.currentRound, 
        maxRounds: room.maxRounds, 
        hintLevel: room.hintLevel,
        underdogs: room.underdogs
      });
      io.to(room.currentDrawerId).emit('request_canvas_state', socket.id);
    }
    // Sync the current hint state instantly!
    socket.emit('timer_update', { time: room.timeRemaining, revealedChars: getRevealedChars(room) }); 
  }
 
  socket.on('start_private_game', () => {
    const room = rooms[socket.roomId];
    if (room && room.isPrivate && room.hostId === socket.id && Object.keys(room.players).length >= 2) {
      
      // FIX: Prevents malicious DevTools spam from restarting a game that is already playing!
      if (room.gameState !== 'waiting' && room.gameState !== 'game_over') return;

      room.currentRound = 1;
      room.drawQueue = Object.keys(room.players);
      room.priorityQueue = [];
      io.to(room.id).emit('game_started'); // NEW: Tell all clients the game is starting!
      startNextTurn(room.id);
    }
  });
  // --- NEW: Live Settings Sync ---
  socket.on('update_room_settings', (settings) => {
    if (!settings || typeof settings !== 'object') return; // FIX: Safe drop for null payloads
    const room = rooms[socket.roomId];
    if (room && room.isPrivate && room.hostId === socket.id) {
      // FIX: Server-side clamp + NaN Protection! 
      // Fallback defaults (||) guarantee the room object never gets corrupted by non-number values.
      if (settings.maxRounds) room.maxRounds = Math.max(1, Math.min(10, parseInt(settings.maxRounds) || 3));
      if (settings.drawTime) room.drawTime = Math.max(30, Math.min(300, parseInt(settings.drawTime) || 120));
      if (settings.hintLevel) room.hintLevel = Math.max(1, Math.min(4, parseInt(settings.hintLevel) || 2));
      if (settings.maxPlayers) room.maxPlayers = Math.max(2, Math.min(8, parseInt(settings.maxPlayers) || 8));
      io.to(room.id).emit('room_settings_updated', { maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel, maxPlayers: room.maxPlayers });
    }
  });

  // --- NEW: Restart Lobby (Forces everyone back to waiting area) ---
  socket.on('restart_lobby', () => {
    const room = rooms[socket.roomId];
    if (room && room.isPrivate && room.hostId === socket.id) {
      room.gameState = 'waiting';
      Object.values(room.players).forEach(p => p.score = 0);
      room.currentRound = 1;
      room.drawQueue = Object.keys(room.players);
      room.priorityQueue = [];
      room.currentDrawerId = null;
      room.currentWord = "";
      room.correctGuessers = [];
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout);
      broadcastPlayers(room.id);
      io.to(room.id).emit('waiting_for_host'); // Pushes everyone back to the canvas settings screen
    }
  });

  // --- NEW: Transfer Host ---
  socket.on('transfer_host', (targetId) => {
    const room = rooms[socket.roomId];
    if (room && room.isPrivate && room.hostId === socket.id && room.players[targetId]) {
      room.hostId = targetId;
      io.to(room.id).emit('host_updated', targetId);
      // FIX: Ensure the newly manually assigned host gets the full settings payload so their UI unlocks!
      io.to(targetId).emit('room_joined', { roomId: room.id, isPrivate: true, isHost: true, maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel, maxPlayers: room.maxPlayers, password: room.password });
      io.to(room.id).emit('chat_message', { sender: "System", text: `${room.players[targetId].name} is now the host.`, isGuess: false });
    }
  });

  // --- NEW: Manual Proceed to Lobby from Stats Screen ---
  socket.on('return_to_lobby', () => {
    const room = rooms[socket.roomId];
    if (!room || room.gameState !== 'game_over') return;
    
    // Only the host can trigger this in private lobbies
    if (room.isPrivate && room.hostId !== socket.id) return;
    
    room.gameState = 'waiting';
    Object.values(room.players).forEach(p => p.score = 0);
    room.currentRound = 1;
    room.drawQueue = Object.keys(room.players);
    room.priorityQueue = [];
    room.currentDrawerId = null;
    room.currentWord = "";
    
    broadcastPlayers(room.id);
    
    if (room.isPrivate) {
        io.to(room.id).emit('waiting_for_host');
      } else {
        // Public lobbies: just send them to the waiting area
        io.to(room.id).emit('waiting_for_players');
        
        // FIX: The Zombie Lobby Fix! 
        // Automatically jump right into the next match if there are still enough players!
        if (Object.keys(room.players).length >= 2) {
           setTimeout(() => startNextTurn(room.id), 3000); // 3 second breather before round 1 starts
        }
      }
    });

  socket.on('word_chosen', (word) => {
    // FIX: Dictionary Injection Protection! Drops massive fake words to protect CPU.
    if (typeof word !== 'string' || word.length > 100) return;
    
    const room = rooms[socket.roomId];
    if (room && socket.id === room.currentDrawerId && room.gameState === 'choosing') {
      startDrawingPhase(room.id, word);
    }
  });

  const cancelAfk = (room) => { if (room && socket.id === room.currentDrawerId && room.gameState === 'drawing') clearTimeout(room.afkTimeout); };

  // FIX: Backend Data Validation! Ensure the payload is an object and strictly strip out malicious injections before broadcasting.
  const isValidDrawData = (data) => data && typeof data.x === 'number' && typeof data.y === 'number';

  socket.on('start', (data) => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId && isValidDrawData(data)) { cancelAfk(room); socket.to(room.id).emit('start', { x: data.x, y: data.y, color: String(data.color).substring(0, 25), size: Number(data.size) || 5 }); } });
  socket.on('draw', (data) => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId && isValidDrawData(data)) socket.to(room.id).emit('draw', { x: data.x, y: data.y, color: String(data.color).substring(0, 25), size: Number(data.size) || 5 }); });
  socket.on('stop', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('stop'); });
  
  socket.on('clear_board', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) { cancelAfk(room); io.to(room.id).emit('clear_board'); } });
  socket.on('fill', (data) => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId && isValidDrawData(data)) { cancelAfk(room); socket.to(room.id).emit('fill', { x: data.x, y: data.y, color: String(data.color).substring(0, 25) }); } });
  
  socket.on('undo', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('undo') });
  socket.on('redo', () => { const room = rooms[socket.roomId]; if(room && socket.id === room.currentDrawerId) socket.to(room.id).emit('redo') });
  
  socket.on('send_canvas_state', (data) => {
    if (!data || typeof data !== 'object') return; // FIX: Prevents "Null Destructuring" DOS crashes!
    const { targetId, canvasData } = data;
    if (typeof canvasData !== 'string' || canvasData.length > 500000) return;
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
    if (!data || typeof data !== 'object') return; // FIX: Safe drop for null payloads
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

  // --- NEW: Like & Dislike System ---
  socket.on('like_drawing', () => {
    const room = rooms[socket.roomId];
    const player = room?.players[socket.id];
    // NEW: Check if they are in the turnVoters set to completely prevent spam!
    if (room && player && socket.id !== room.currentDrawerId && (!room.turnVoters || !room.turnVoters.has(socket.id))) {
      if (!room.turnVoters) room.turnVoters = new Set();
      room.turnVoters.add(socket.id); // Lock them out for this turn
      io.to(room.id).emit('chat_message', { sender: "System", text: `${player.name} liked this drawing!`, isLike: true });
    }
  });

  socket.on('dislike_drawing', () => {
    const room = rooms[socket.roomId];
    const player = room?.players[socket.id];
    // NEW: Check if they are in the turnVoters set to completely prevent spam!
    if (room && player && socket.id !== room.currentDrawerId && (!room.turnVoters || !room.turnVoters.has(socket.id))) {
      if (!room.turnVoters) room.turnVoters = new Set();
      room.turnVoters.add(socket.id); // Lock them out for this turn
      io.to(room.id).emit('chat_message', { sender: "System", text: `${player.name} disliked this drawing!`, isDislike: true });
    }
  });

  socket.on('chat_message', (text) => {
    // FIX: Immediately drop abnormally massive text payloads to prevent Server Freezes (DOS)!
    if (typeof text !== 'string' || text.length > 200) return; 

    const room = rooms[socket.roomId];
    if (!room) return;
    
    const player = room.players[socket.id];
    if (!player) return;
    if (socket.id === room.currentDrawerId) return;
    
    if (room.gameState === 'drawing' && room.currentWord && text.trim().toLowerCase() === room.currentWord.toLowerCase()) {
      // Prevent multiple points if they already guessed it
      if (room.correctGuessers && room.correctGuessers.includes(socket.id)) {
        return socket.emit('chat_message', { sender: "System", text: `You already guessed the word!`, isGuess: false });
      }

      room.correctGuessers.push(socket.id);
      const rank = room.correctGuessers.length;

     // 1. Point Math: Base points per rank
      let guessPoints = 30;
      if (rank === 1) guessPoints = 200; // FIX: Increased 1st guesser points to 200
      else if (rank === 2) guessPoints = 80;
      else if (rank === 3) guessPoints = 60;
      else if (rank === 4) guessPoints = 50;
      else if (rank === 5) guessPoints = 40;

      // 2. NEW: Underdog ability! Double points for ANY rank!
      if (room.underdogs && room.underdogs.includes(socket.id)) {
        guessPoints *= 2;
      }

      // 3. --- 30% Time Reduction for First Guess ---
      if (rank === 1) {
        const totalTime = room.drawTime; 
        const thresholdTime = totalTime * 0.60; 
        const reductionAmount = totalTime * 0.30; // FIX: Reduced from 35% to 30% 

        if (room.timeRemaining >= thresholdTime) {
          room.timeRemaining -= Math.floor(reductionAmount);
          
          io.to(room.id).emit('chat_message', { 
            sender: "System", 
            text: `⏰ First guess! The clock has been reduced by ${Math.floor(reductionAmount)} seconds!`, 
            isGuess: false 
          });
        }
      }

      // 2. Drawer Math: Dynamically calculates points so they max out at exactly 90!
      const totalGuessers = Math.max(1, Object.keys(room.players).length - 1);
          const drawerPoints = Math.floor(100 / totalGuessers);

          player.score += guessPoints;
          room.turnScores[socket.id] = (room.turnScores[socket.id] || 0) + guessPoints; // NEW: Save for summary
          
          if (room.players[room.currentDrawerId]) {
            room.players[room.currentDrawerId].score += drawerPoints;
            room.turnScores[room.currentDrawerId] = (room.turnScores[room.currentDrawerId] || 0) + drawerPoints; // NEW
          }
          
          broadcastPlayers(room.id); 
          io.to(room.id).emit('chat_message', { sender: player.name, text: "guessed the word!", isGuess: true });
          
          // FIX: Send the actual word back to the winner so their UI reveals it!
          socket.emit('secret_word', room.currentWord);

          // 3. End round early ONLY if EVERYONE has guessed the word!
          if (room.correctGuessers.length >= totalGuessers) {
            clearInterval(room.timerInterval); 
            clearTimeout(room.afkTimeout); 
            
            // NEW: Emit summary data before advancing!
            const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
            io.to(room.id).emit('turn_summary', { word: room.currentWord, reason: "Everyone guessed the word!", scores: summaryData });

            io.to(room.id).emit('chat_message', { sender: "System", text: `Everyone guessed the word! The word was: ${room.currentWord}`, isGuess: false });
            setTimeout(() => startNextTurn(room.id), 4000);
          }

    } else {
      // --- NEW: Ghost Chat for Guessers! ---
      if (room.gameState === 'drawing' && room.correctGuessers && room.correctGuessers.includes(socket.id)) {
        const ghostMsg = { sender: player.name, text: text, isGuess: false, isGuesserChat: true };
        
        // Send back to the sender
        socket.emit('chat_message', ghostMsg);
        
        // Send to the drawer
        if (room.currentDrawerId) {
          io.to(room.currentDrawerId).emit('chat_message', ghostMsg);
        }
        
        // Send to all other correct guessers
        room.correctGuessers.forEach(guesserId => {
          if (guesserId !== socket.id) {
            io.to(guesserId).emit('chat_message', ghostMsg);
          }
        });
        
        return; // Stops here! The clueless guessers will never receive this message.
      }

      // Normal broadcast for clueless guessers or waiting phase
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

    // FIX: Grab the player's name before deleting them so we can announce they left!
    const leavingPlayerName = room.players[socket.id] ? room.players[socket.id].name : "A player";

    delete room.players[socket.id];
    room.drawQueue = room.drawQueue.filter(id => id !== socket.id);
    room.priorityQueue = room.priorityQueue.filter(id => id !== socket.id);

    // NEW: Remove them from the winners list if they had already guessed the word!
    if (room.correctGuessers) {
      room.correctGuessers = room.correctGuessers.filter(id => id !== socket.id);
    }
    
    // EXISTING: Host Migration
    if (room.isPrivate && socket.id === room.hostId) {
      const remainingIds = Object.keys(room.players);
      if (remainingIds.length > 0) {
        room.hostId = remainingIds[0];
        const newHostName = room.players[room.hostId].name;
        
        // FIX: Broadcast the host update to EVERYONE so their UIs sync instantly
        io.to(room.id).emit('host_updated', room.hostId);
        
        // Ensure the new host gets the full updated data (including maxPlayers and password) for their settings menu
        io.to(room.hostId).emit('room_joined', { roomId: room.id, isPrivate: true, isHost: true, maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel, maxPlayers: room.maxPlayers, password: room.password });
        
        // NEW: Announce the host transfer in the chat for everyone to see!
        io.to(room.id).emit('chat_message', { sender: "System", text: `👑 The host left. ${newHostName} is now the host.`, isGuess: false });
      }
    }

    const remainingPlayers = Object.keys(room.players).length;

    // EXISTING: Empty Room Cleanup
    if (remainingPlayers === 0) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout);
      delete rooms[socket.roomId];
      return;
    }

    broadcastPlayers(room.id); 
    // NEW: Announce the departure to the lobby so the frontend can play the leave sound!
    io.to(room.id).emit('chat_message', { sender: "System", text: `${leavingPlayerName} left the lobby. (${remainingPlayers}/${room.maxPlayers})`, isGuess: false });
    
    // EXISTING: Less than 2 players left
    if (remainingPlayers < 2) {
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
    } 
    // --- NEW BUG FIX: Catch if the Drawer leaves while choosing a word! ---
    else if (room.gameState === 'choosing' && socket.id === room.currentDrawerId) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout);
      
      io.to(room.id).emit('chat_message', { 
        sender: "System", 
        text: `The drawer left before picking a word! Skipping turn...`, 
        isGuess: false 
      });
      
      // Clear out the current drawer and immediately move to the next turn!
      room.currentDrawerId = null;
      startNextTurn(room.id);
    }
    // NEW & UPDATED: Catch edge cases if a player leaves during a drawing phase!
    else if (room.gameState === 'drawing') {
      const totalGuessers = remainingPlayers - 1;

      // Scenario A: The Drawer left
      if (socket.id === room.currentDrawerId) {
        clearInterval(room.timerInterval);
        clearTimeout(room.afkTimeout); 
        
        const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
        io.to(room.id).emit('turn_summary', { word: room.currentWord, reason: "The drawer left!", scores: summaryData });
        
        io.to(room.id).emit('chat_message', { sender: "System", text: `The drawer left! The word was: ${room.currentWord}`, isGuess: false });
        setTimeout(() => startNextTurn(room.id), 4000);
      } 
      // Scenario B: The last clueless guesser left (Meaning everyone else left in the room already guessed it!)
      else if (room.correctGuessers.length >= totalGuessers) {
        clearInterval(room.timerInterval);
        clearTimeout(room.afkTimeout); 
        
        const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
        io.to(room.id).emit('turn_summary', { word: room.currentWord, reason: "Everyone guessed the word!", scores: summaryData });

        io.to(room.id).emit('chat_message', { sender: "System", text: `Everyone guessed the word! The word was: ${room.currentWord}`, isGuess: false });
        setTimeout(() => startNextTurn(room.id), 4000);
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));