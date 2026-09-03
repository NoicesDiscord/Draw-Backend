const { rooms, wordList } = require('../state/state');
const { getRevealedChars } = require('../utils');

// We pass `io` into these functions so they can broadcast directly to the room
function startNextTurn(io, roomId) {
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
      room.gameState = 'game_over';
      const finalStandings = playerIds
        .map(id => ({ name: room.players[id].name, score: room.players[id].score }))
        .sort((a, b) => b.score - a.score);
      io.to(roomId).emit('game_over', finalStandings);
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
    return startNextTurn(io, roomId); 
  }

  room.gameState = 'choosing';
  room.timeRemaining = 15; 
  
  let choices = [];
  for (let i = 0; i < 5; i++) {
      if (room.availableWords.length === 0) {
        room.availableWords = (room.customWords && room.customWords.length > 0) ? [...room.customWords, ...wordList] : [...wordList];
      }
      const randIndex = Math.floor(Math.random() * room.availableWords.length);
      choices.push(room.availableWords.splice(randIndex, 1)[0]);
  }

  io.to(roomId).emit('clear_board');
  io.to(roomId).emit('choosing_word', { drawerName: room.players[room.currentDrawerId].name });
  io.to(room.currentDrawerId).emit('your_word_choices', choices);

  room.timerInterval = setInterval(() => {
    room.timeRemaining--;
    io.to(roomId).emit('timer_update', room.timeRemaining); 

    if (room.timeRemaining <= 0) {
      startDrawingPhase(io, roomId, choices[0]);
    }
  }, 1000);
}

function startDrawingPhase(io, roomId, selectedWord) {
  const room = rooms[roomId];
  if (!room) return;

  clearInterval(room.timerInterval);
  clearTimeout(room.afkTimeout);
  
  room.gameState = 'drawing';
  room.currentWord = selectedWord;
  room.timeRemaining = room.drawTime; 
  room.endsAt = Date.now() + (room.drawTime * 1000);
  room.correctGuessers = []; 
  room.drawingHistory = [];
  
  const allScores = Object.values(room.players).map(p => p.score).sort((a, b) => b - a);
  const thirdHighestScore = allScores.length > 2 ? allScores[2] : (allScores[allScores.length - 1] || 0);

  room.underdogs = Object.keys(room.players).filter(id => {
    const p = room.players[id];
    const isLateJoiner = p.joinedAtRound >= 2; 
    const isCatchingUp = p.score < (thirdHighestScore - 100);
    return isLateJoiner && isCatchingUp && id !== room.currentDrawerId;
  });

  room.turnScores = {};
  room.turnVoters = new Set(); 
  Object.keys(room.players).forEach(id => room.turnScores[id] = 0);

  const words = [];
  const wordStartIndices = [];
  let currentWord = "";
  let currentStart = -1;
  
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
  
  for (let p = 0; p < maxLength; p++) {
    for (let wIdx = 0; wIdx < words.length; wIdx++) {
      if (p < wordPriorities[wIdx].length) {
        allowedIndices.push(wordStartIndices[wIdx] + wordPriorities[wIdx][p]);
      }
    }
  }
  room.hintOrder = allowedIndices;

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

  io.to(roomId).emit('round_update', { 
    drawerName: room.players[room.currentDrawerId].name, 
    wordLength: room.currentWord.length, 
    skeleton: room.skeleton,
    currentRound: room.currentRound, 
    maxRounds: room.maxRounds, 
    hintLevel: room.hintLevel,
    underdogs: room.underdogs,
    endsAt: room.endsAt
  });
  
  io.to(room.currentDrawerId).emit('secret_word', room.currentWord);

  let lastRevealedChars = "{}";

  room.timerInterval = setInterval(() => {
    room.timeRemaining = Math.max(0, Math.ceil((room.endsAt - Date.now()) / 1000));
    
    const currentRevealed = getRevealedChars(room);
    const currentRevealedStr = JSON.stringify(currentRevealed);
    
    if (currentRevealedStr !== lastRevealedChars) {
       lastRevealedChars = currentRevealedStr;
       io.to(roomId).emit('hint_update', currentRevealed); 
    }

    if (room.timeRemaining <= 0) {
      clearInterval(room.timerInterval);
      clearTimeout(room.afkTimeout); 
      const summaryData = Object.values(room.players).map(p => ({ name: p.name, earned: room.turnScores[p.id] || 0 })).sort((a, b) => b.earned - a.earned);
      io.to(roomId).emit('turn_summary', { word: room.currentWord, reason: "Time's up!", scores: summaryData });
      io.to(roomId).emit('chat_message', { sender: "System", text: `Time's up! The word was: ${room.currentWord}`, isGuess: false });
      setTimeout(() => startNextTurn(io, roomId), 4000); 
    }
  }, 1000);

  room.afkTimeout = setTimeout(() => {
    clearInterval(room.timerInterval); 
    io.to(roomId).emit('chat_message', { sender: "System", text: `Drawer is AFK! Skipping turn...`, isGuess: false });
    startNextTurn(io, roomId); 
  }, 60000); 
}

module.exports = { startNextTurn, startDrawingPhase };