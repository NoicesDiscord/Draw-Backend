const { rooms, disconnectTimeouts, offlinePlayers } = require('../state/state');
const { getOrCreatePublicRoom, createPrivateRoom, broadcastPlayers } = require('../rooms/roomManager');
const { startNextTurn, startDrawingPhase } = require('../game/turnManager');
const { getRevealedChars, getEditDistance } = require('../utils');

module.exports = function initializeSockets(io) {
  
  const getPlayerBySocketId = (id) => {
    for (const roomId in rooms) {
      if (rooms[roomId].players[id]) return { ...rooms[roomId].players[id], roomId };
    }
    return null;
  };

  io.on('connection', (socket) => {
    
    socket.on('resume_session', (data) => {
      const { sessionId } = data;
      if (offlinePlayers[sessionId]) {
        const { roomId, oldSocketId } = offlinePlayers[sessionId];
        const room = rooms[roomId];

        if (room && room.players[oldSocketId]) {
          clearTimeout(disconnectTimeouts[sessionId]);
          delete disconnectTimeouts[sessionId];
          delete offlinePlayers[sessionId];

          socket.join(roomId);
          socket.roomId = roomId;
          socket.sessionId = sessionId;

          const newSocketId = socket.id;
          room.players[newSocketId] = room.players[oldSocketId];
          room.players[newSocketId].id = newSocketId;
          room.players[newSocketId].isOffline = false;
          delete room.players[oldSocketId];

          if (room.hostId === oldSocketId) room.hostId = newSocketId;
          if (room.currentDrawerId === oldSocketId) room.currentDrawerId = newSocketId;
          room.drawQueue = room.drawQueue.map(id => id === oldSocketId ? newSocketId : id);
          room.priorityQueue = room.priorityQueue.map(id => id === oldSocketId ? newSocketId : id);
          
          if (room.turnScores[oldSocketId] !== undefined) {
            room.turnScores[newSocketId] = room.turnScores[oldSocketId];
            delete room.turnScores[oldSocketId];
          }

          if (room.turnVoters && room.turnVoters.has(oldSocketId)) {
            room.turnVoters.delete(oldSocketId);
            room.turnVoters.add(newSocketId);
          }

          socket.emit('session_restored');
          broadcastPlayers(io, roomId);
          return;
        }
      }
      socket.emit('session_restore_failed');
    });

    socket.on('request_game_state', () => {
      const room = rooms[socket.roomId];
      if (!room) return;

      const guesserNames = (room.correctGuessers || []).map(id => room.players[id] ? room.players[id].name : id);

      socket.emit('game_state_snapshot', {
        gameState: room.gameState,
        currentRound: room.currentRound,
        currentDrawerId: room.currentDrawerId,
        drawerName: room.players[room.currentDrawerId] ? room.players[room.currentDrawerId].name : "",
        endsAt: room.endsAt, 
        timeRemaining: room.timeRemaining, 
        wordSkeleton: room.skeleton,
        revealedChars: getRevealedChars(room),
        drawingHistory: room.drawingHistory,
        drawingRevision: room.drawingRevision, 
        correctGuessers: guesserNames 
      });
    });

    function syncLateJoiner(socket, room) {
      room.priorityQueue.push(socket.id);
      if (room.gameState === 'choosing') {
        socket.emit('choosing_word', { drawerName: room.players[room.currentDrawerId].name });
      } else if (room.gameState === 'drawing') {
        socket.emit('round_update', { 
          drawerName: room.players[room.currentDrawerId].name, 
          wordLength: room.currentWord.length, 
          skeleton: room.skeleton, 
          currentRound: room.currentRound, 
          maxRounds: room.maxRounds, 
          hintLevel: room.hintLevel,
          underdogs: room.underdogs,
          endsAt: room.endsAt
        });
      }
      socket.emit('hint_update', getRevealedChars(room)); 
    }

    socket.on('join_game', (data) => {
      if (!data) return; 
      const playerName = typeof data === 'string' ? data : (data.playerName || "Unknown");
      const sessionId = data.sessionId || socket.id; 
      socket.sessionId = sessionId;
      const requestedRoomId = data.roomId;
      const privateSettings = data.privateSettings;
      const providedPassword = data.password;

      let roomId;

      if (privateSettings) {
        roomId = createPrivateRoom(socket.id, privateSettings);
      } else if (requestedRoomId) {
        const room = rooms[requestedRoomId];
        if (!room) return socket.emit('room_error', "This room does not exist or has expired.");
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
      room.players[socket.id] = { id: socket.id, name: playerName, score: 0, joinedAtRound: room.currentRound || 1, packetsThisSecond: 0, lastPacketReset: Date.now() };
      
      const allScores = Object.values(room.players).map(p => p.score).sort((a, b) => b - a);
      const thirdHighestScore = allScores.length > 2 ? allScores[2] : (allScores[allScores.length - 1] || 0);

      room.underdogs = Object.keys(room.players).filter(id => {
        const p = room.players[id];
        const isLateJoiner = p.joinedAtRound >= 2; 
        const isCatchingUp = p.score < (thirdHighestScore - 100);
        return isLateJoiner && isCatchingUp && id !== room.currentDrawerId;
      });
      
      io.to(roomId).emit('update_underdogs', room.underdogs);
      
      socket.emit('room_joined', { 
        roomId: room.id, isPrivate: room.isPrivate, isHost: room.hostId === socket.id,
        maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel,
        maxPlayers: room.maxPlayers, password: room.password
      });

      broadcastPlayers(io, roomId); 
      io.to(roomId).emit('chat_message', { sender: "System", text: `${playerName} joined the lobby. (${Object.keys(room.players).length}/${room.maxPlayers})`, isGuess: false });

      if (!room.isPrivate) {
        if (Object.keys(room.players).length >= 2 && !room.currentDrawerId) {
          room.currentRound = 1;
          room.drawQueue = Object.keys(room.players);
          room.priorityQueue = [];
          startNextTurn(io, roomId); 
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
   
    socket.on('start_private_game', () => {
      const room = rooms[socket.roomId];
      if (room && room.isPrivate && room.hostId === socket.id && Object.keys(room.players).length >= 2) {
        if (room.gameState !== 'waiting' && room.gameState !== 'game_over') return;
        room.currentRound = 1;
        room.drawQueue = Object.keys(room.players);
        room.priorityQueue = [];
        io.to(room.id).emit('game_started'); 
        startNextTurn(io, room.id);
      }
    });

    socket.on('update_room_settings', (settings) => {
      if (!settings || typeof settings !== 'object') return; 
      const room = rooms[socket.roomId];
      if (room && room.isPrivate && room.hostId === socket.id) {
        if (settings.maxRounds) room.maxRounds = Math.max(1, Math.min(10, parseInt(settings.maxRounds) || 3));
        if (settings.drawTime) room.drawTime = Math.max(30, Math.min(300, parseInt(settings.drawTime) || 120));
        if (settings.hintLevel) room.hintLevel = Math.max(1, Math.min(4, parseInt(settings.hintLevel) || 2));
        if (settings.maxPlayers) room.maxPlayers = Math.max(2, Math.min(8, parseInt(settings.maxPlayers) || 8));
        io.to(room.id).emit('room_settings_updated', { maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel, maxPlayers: room.maxPlayers });
      }
    });

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
        broadcastPlayers(io, room.id);
        io.to(room.id).emit('waiting_for_host'); 
      }
    });

    socket.on('transfer_host', (targetId) => {
      const room = rooms[socket.roomId];
      if (room && room.isPrivate && room.hostId === socket.id && room.players[targetId]) {
        room.hostId = targetId;
        io.to(room.id).emit('host_updated', targetId);
        io.to(targetId).emit('room_joined', { roomId: room.id, isPrivate: true, isHost: true, maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel, maxPlayers: room.maxPlayers, password: room.password });
        io.to(room.id).emit('chat_message', { sender: "System", text: `${room.players[targetId].name} is now the host.`, isGuess: false });
      }
    });

    socket.on('return_to_lobby', () => {
      const room = rooms[socket.roomId];
      if (!room || room.gameState !== 'game_over') return;
      if (room.isPrivate && room.hostId !== socket.id) return;
      
      room.gameState = 'waiting';
      Object.values(room.players).forEach(p => p.score = 0);
      room.currentRound = 1;
      room.drawQueue = Object.keys(room.players);
      room.priorityQueue = [];
      room.currentDrawerId = null;
      room.currentWord = "";
      
      broadcastPlayers(io, room.id);
      
      if (room.isPrivate) {
          io.to(room.id).emit('waiting_for_host');
        } else {
          io.to(room.id).emit('waiting_for_players');
          if (Object.keys(room.players).length >= 2) {
             setTimeout(() => startNextTurn(io, room.id), 3000); 
          }
        }
    });

    socket.on('word_chosen', (word) => {
      if (typeof word !== 'string' || word.length > 100) return;
      const room = rooms[socket.roomId];
      if (room && socket.id === room.currentDrawerId && room.gameState === 'choosing') {
        startDrawingPhase(io, room.id, word);
      }
    });

    socket.on('start', (data) => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('start', data);
            const room = rooms[player.roomId];
            if (room) room.drawingHistory.push({ type: 'start', ...data });
        }
    });
    
    socket.on('draw_packet', (data) => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('draw_packet', data);
            const room = rooms[player.roomId];
            if (room) room.drawingHistory.push({ type: 'draw_packet', ...data });
        }
    });

    socket.on('draw', (data) => {
         const player = getPlayerBySocketId(socket.id);
         if (player && player.roomId) {
             socket.to(player.roomId).emit('draw', data);
             const room = rooms[player.roomId];
             if (room) room.drawingHistory.push({ type: 'draw', ...data });
         }
    });

    socket.on('stop', () => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('stop');
            const room = rooms[player.roomId];
            if (room) room.drawingHistory.push({ type: 'stop' });
        }
    });

    socket.on('fill', (data) => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('fill', data);
            const room = rooms[player.roomId];
            if (room) room.drawingHistory.push({ type: 'fill', ...data });
        }
    });
    
    socket.on('undo', () => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('undo');
            const room = rooms[player.roomId];
            if (room) room.drawingHistory.push({ type: 'undo' });
        }
    });

    socket.on('redo', () => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('redo');
            const room = rooms[player.roomId];
            if (room) room.drawingHistory.push({ type: 'redo' });
        }
    });

    socket.on('clear_board', () => {
        const player = getPlayerBySocketId(socket.id);
        if (player && player.roomId) {
            socket.to(player.roomId).emit('clear_board');
            const room = rooms[player.roomId];
            if (room) room.drawingHistory = []; 
        }
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
        type: 'votekick', targetId: targetId, targetName: target.name, initiatorName: initiator.name,
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
      if (!data || typeof data !== 'object') return; 
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

    socket.on('like_drawing', () => {
      const room = rooms[socket.roomId];
      const player = room?.players[socket.id];
      if (room && player && socket.id !== room.currentDrawerId && (!room.turnVoters || !room.turnVoters.has(socket.id))) {
        if (!room.turnVoters) room.turnVoters = new Set();
        room.turnVoters.add(socket.id); 
        io.to(room.id).emit('chat_message', { sender: "System", text: `${player.name} liked this drawing!`, isLike: true });
      }
    });

    socket.on('dislike_drawing', () => {
      const room = rooms[socket.roomId];
      const player = room?.players[socket.id];
      if (room && player && socket.id !== room.currentDrawerId && (!room.turnVoters || !room.turnVoters.has(socket.id))) {
        if (!room.turnVoters) room.turnVoters = new Set();
        room.turnVoters.add(socket.id); 
        io.to(room.id).emit('chat_message', { sender: "System", text: `${player.name} disliked this drawing!`, isDislike: true });
      }
    });

    socket.on('chat_message', (text) => {
      if (typeof text !== 'string' || text.length > 200) return; 

      const room = rooms[socket.roomId];
      if (!room) return;
      const player = room.players[socket.id];
      if (!player) return;
      if (socket.id === room.currentDrawerId) return;
      
      if (room.gameState === 'drawing' && room.currentWord && text.trim().toLowerCase() === room.currentWord.toLowerCase()) {
        if (room.correctGuessers && room.correctGuessers.includes(player.name)) {
          return socket.emit('chat_message', { sender: "System", text: `You already guessed the word!`, isGuess: false });
        }

        room.correctGuessers.push(player.name);
        const rank = room.correctGuessers.length;

        let guessPoints = 30;
        if (rank === 1) guessPoints = 200; 
        else if (rank === 2) guessPoints = 80;
        else if (rank === 3) guessPoints = 60;
        else if (rank === 4) guessPoints = 50;
        else if (rank === 5) guessPoints = 40;

        if (room.underdogs && room.underdogs.includes(socket.id)) {
          guessPoints *= 2;
        }

        if (rank === 1) {
          const totalTime = room.drawTime; 
          const thresholdTime = totalTime * 0.60; 
          const reductionAmount = totalTime * 0.30; 

          if (room.timeRemaining >= thresholdTime) {
            room.timeRemaining -= Math.floor(reductionAmount);
            room.endsAt -= Math.floor(reductionAmount) * 1000; 
            
            io.to(room.id).emit('time_reduction', { endsAt: room.endsAt }); 
            io.to(room.id).emit('chat_message', { 
              sender: "System", 
              text: `⏰ First guess! The clock has been reduced by ${Math.floor(reductionAmount)} seconds!`, 
              isGuess: false 
            });
          }
        }

        const totalGuessers = Math.max(1, Object.keys(room.players).length - 1);
        const drawerPoints = Math.floor(100 / totalGuessers);

        player.score += guessPoints;
        room.turnScores[socket.id] = (room.turnScores[socket.id] || 0) + guessPoints; 
        
        if (room.players[room.currentDrawerId]) {
          room.players[room.currentDrawerId].score += drawerPoints;
          room.turnScores[room.currentDrawerId] = (room.turnScores[room.currentDrawerId] || 0) + drawerPoints; 
        }
        
        broadcastPlayers(io, room.id); 
        io.to(room.id).emit('chat_message', { sender: player.name, text: "guessed the word!", isGuess: true });
        socket.emit('secret_word', room.currentWord);

        if (room.correctGuessers.length >= totalGuessers) {
          clearInterval(room.timerInterval); 
          clearTimeout(room.afkTimeout); 
          
          const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
          io.to(room.id).emit('turn_summary', { word: room.currentWord, reason: "Everyone guessed the word!", scores: summaryData });
          io.to(room.id).emit('chat_message', { sender: "System", text: `Everyone guessed the word! The word was: ${room.currentWord}`, isGuess: false });
          setTimeout(() => startNextTurn(io, room.id), 4000);
        }

      } else {
        if (room.gameState === 'drawing' && room.correctGuessers && room.correctGuessers.includes(player.name)) {
          const ghostMsg = { sender: player.name, text: text, isGuess: false, isGuesserChat: true };
          socket.emit('chat_message', ghostMsg);
          if (room.currentDrawerId) io.to(room.currentDrawerId).emit('chat_message', ghostMsg);
          
          Object.keys(room.players).forEach(guesserId => {
            if (guesserId !== socket.id && room.correctGuessers.includes(room.players[guesserId].name)) {
              io.to(guesserId).emit('chat_message', ghostMsg);
            }
          });
          return; 
        }

        io.to(room.id).emit('chat_message', { sender: player.name, text: text, isGuess: false });
        
        if (room.gameState === 'drawing' && room.currentWord && room.currentWord.length > 2) {
          const guess = text.trim().toLowerCase();
          const target = room.currentWord.toLowerCase();
          
          if (Math.abs(guess.length - target.length) <= 2) {
            const typos = getEditDistance(guess, target);
            if (typos === 1 || (typos === 2 && target.length >= 5)) {
              socket.emit('chat_message', { 
                sender: "System", text: `'${text}' is very close! Keep trying! 💡`, 
                isGuess: false, isCloseGuess: true
              });
            }
          }
        }
      }
    });
    
    socket.on('disconnect', () => {
      const room = rooms[socket.roomId];
      if (!room || !room.players[socket.id]) return;

      room.players[socket.id].isOffline = true;
      broadcastPlayers(io, room.id);

      const timeout = setTimeout(() => {
        if (!offlinePlayers[socket.sessionId]) return;

        const leavingPlayerName = room.players[socket.id] ? room.players[socket.id].name : "A player";

        delete room.players[socket.id];
        room.drawQueue = room.drawQueue.filter(id => id !== socket.id);
        room.priorityQueue = room.priorityQueue.filter(id => id !== socket.id);
        
        if (room.isPrivate && socket.id === room.hostId) {
          const remainingIds = Object.keys(room.players);
          if (remainingIds.length > 0) {
            room.hostId = remainingIds[0];
            const newHostName = room.players[room.hostId].name;
            io.to(room.id).emit('host_updated', room.hostId);
            io.to(room.hostId).emit('room_joined', { roomId: room.id, isPrivate: true, isHost: true, maxRounds: room.maxRounds, drawTime: room.drawTime, hintLevel: room.hintLevel, maxPlayers: room.maxPlayers, password: room.password });
            io.to(room.id).emit('chat_message', { sender: "System", text: `👑 The host left. ${newHostName} is now the host.`, isGuess: false });
          }
        }

        const remainingPlayers = Object.keys(room.players).length;

        if (remainingPlayers === 0) {
          clearInterval(room.timerInterval);
          clearTimeout(room.afkTimeout);
          delete rooms[socket.roomId];
        } else {
          broadcastPlayers(io, room.id); 
          io.to(room.id).emit('chat_message', { sender: "System", text: `${leavingPlayerName} left the lobby. (${remainingPlayers}/${room.maxPlayers})`, isGuess: false });
          
          if (remainingPlayers < 2) {
            clearInterval(room.timerInterval);
            clearTimeout(room.afkTimeout); 
            room.gameState = 'waiting';
            room.currentDrawerId = null;
            room.currentWord = "";
            if (room.isPrivate) io.to(room.id).emit('waiting_for_host');
            else io.to(room.id).emit('waiting_for_players');
          } 
          else if (room.gameState === 'choosing' && socket.id === room.currentDrawerId) {
            clearInterval(room.timerInterval);
            clearTimeout(room.afkTimeout);
            io.to(room.id).emit('chat_message', { sender: "System", text: `The drawer left before picking a word! Skipping turn...`, isGuess: false });
            room.currentDrawerId = null;
            startNextTurn(io, room.id);
          }
          else if (room.gameState === 'drawing') {
            const totalGuessers = remainingPlayers - 1;
            if (socket.id === room.currentDrawerId) {
              clearInterval(room.timerInterval);
              clearTimeout(room.afkTimeout); 
              const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
              io.to(room.id).emit('turn_summary', { word: room.currentWord, reason: "The drawer left!", scores: summaryData });
              io.to(room.id).emit('chat_message', { sender: "System", text: `The drawer left! The word was: ${room.currentWord}`, isGuess: false });
              setTimeout(() => startNextTurn(io, room.id), 4000);
            } else if (room.correctGuessers.length >= totalGuessers) {
              clearInterval(room.timerInterval);
              clearTimeout(room.afkTimeout); 
              const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
              io.to(room.id).emit('turn_summary', { word: room.currentWord, reason: "Everyone guessed the word!", scores: summaryData });
              io.to(room.id).emit('chat_message', { sender: "System", text: `Everyone guessed the word! The word was: ${room.currentWord}`, isGuess: false });
              setTimeout(() => startNextTurn(io, room.id), 4000);
            }
          }
        }
        delete disconnectTimeouts[socket.sessionId];
        delete offlinePlayers[socket.sessionId];
      }, 30000);

      disconnectTimeouts[socket.sessionId] = timeout;
      offlinePlayers[socket.sessionId] = { roomId: room.id, oldSocketId: socket.id };
    });
  });
};