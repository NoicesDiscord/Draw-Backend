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
    parseInt(settings.hintLevel) || 2,
    settings.password || null // NEW: Password support!
  );
  return newRoomId;
}

function createRoomObject(id, isPrivate, hostId, maxPlayers, maxRounds, drawTime, customWords = null, hintLevel = 2, password = null) {
  return {
    id, isPrivate, hostId, maxPlayers, maxRounds, drawTime,
    players: {}, currentWord: "", currentDrawerId: null,
    gameState: 'waiting', timeRemaining: 0, timerInterval: null,
    afkTimeout: null, currentRound: 1, drawQueue: [], priorityQueue: [], activeVotes: {},
    correctGuessers: [], turnScores: {}, underdogs: [], // NEW: Tracks underdogs
    availableWords: customWords && customWords.length > 0 ? [...customWords] : [...wordList]
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
    // FIX: If the lobby plays so many rounds that they completely run out of words, refill the bucket!
    if (room.availableWords.length === 0) {
      room.availableWords = (room.customWords && room.customWords.length > 0) ? [...room.customWords] : [...wordList];
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
  
  // NEW: Calculate Underdogs BEFORE wiping the turn scores!
  // Anyone who played the last turn but scored 0 gets the buff, unless they draw next!
  if (Object.keys(room.turnScores).length > 0) {
    room.underdogs = Object.keys(room.players).filter(id => 
      room.turnScores[id] === 0 && id !== room.currentDrawerId
    );
  } else {
    room.underdogs = []; // First turn of the game gets no underdogs
  }

  // NEW: Reset turn scores for the new round!
  room.turnScores = {};
  room.turnVoters = new Set(); 
  Object.keys(room.players).forEach(id => room.turnScores[id] = 0);

  // FIX: Include hintLevel and underdogs in the round update
  io.to(roomId).emit('round_update', { 
    drawerName: room.players[room.currentDrawerId].name, 
    wordLength: room.currentWord.length, 
    word: room.currentWord, 
    currentRound: room.currentRound, 
    maxRounds: room.maxRounds, 
    hintLevel: room.hintLevel,
    underdogs: room.underdogs // NEW
  });
  io.to(room.currentDrawerId).emit('secret_word', room.currentWord);

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    io.to(roomId).emit('timer_update', room.timeRemaining); 

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
    const playerName = typeof data === 'string' ? data : data.playerName;
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
      socket.emit('round_update', { 
        drawerName: room.players[room.currentDrawerId].name, 
        wordLength: room.currentWord.length, 
        word: room.currentWord, 
        currentRound: room.currentRound, 
        maxRounds: room.maxRounds, 
        hintLevel: room.hintLevel,
        underdogs: room.underdogs // NEW
      });
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
      io.to(room.id).emit('game_started'); // NEW: Tell all clients the game is starting!
      startNextTurn(room.id);
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

     // 1. Point Math: 1st=150, 2nd=80, 3rd=60, 4th=50, 5th=40, 6th+=30
      let guessPoints = 30;
      if (rank === 1) {
        // Underdog ability! If they have the buff, they get Double Points (300)
        if (room.underdogs && room.underdogs.includes(socket.id)) {
          guessPoints = 300;
        } else {
          guessPoints = 150;
        }

        // --- NEW: 35% Time Reduction for First Guess ---
        const totalTime = room.drawTime; 
        const thresholdTime = totalTime * 0.60; // 60% of total time
        const reductionAmount = totalTime * 0.35; // 35% of total time

        // Only trigger if the remaining time is greater than or equal to 60% of the total clock
        if (room.timeRemaining >= thresholdTime) {
          room.timeRemaining -= Math.floor(reductionAmount);
          
          // Announce the time drop to the lobby!
          io.to(room.id).emit('chat_message', { 
            sender: "System", 
            text: `⏰ First guess! The clock has been reduced by ${Math.floor(reductionAmount)} seconds!`, 
            isGuess: false 
          });
        }
      }
      else if (rank === 2) guessPoints = 85;
      else if (rank === 3) guessPoints = 70;
      else if (rank === 4) guessPoints = 60;
      else if (rank === 5) guessPoints = 40;

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
      // NEW ANTI-SPOIL SYSTEM: If you already guessed it, you can't type normal messages to spoil it for others!
      if (room.gameState === 'drawing' && room.correctGuessers && room.correctGuessers.includes(socket.id)) {
        return socket.emit('chat_message', { sender: "System", text: `Shh! You already guessed it. Don't spoil it for the others!`, isGuess: false });
      }

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
        // FIX: Ensure the new host also gets the hint level data so their UI doesn't break
        io.to(room.hostId).emit('room_joined', { roomId: room.id, isPrivate: true, isHost: true, maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel });
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