const { rooms, PUBLIC_MAX_PLAYERS, wordList } = require('../state/state');

let roomCounter = 1;

function getOrCreatePublicRoom() {
  for (const roomId in rooms) {
    if (!rooms[roomId].isPrivate && Object.keys(rooms[roomId].players).length < PUBLIC_MAX_PLAYERS) {
      return roomId;
    }
  }
  const newRoomId = `public_${roomCounter++}`;
  rooms[newRoomId] = createRoomObject(newRoomId, false, null, PUBLIC_MAX_PLAYERS, 3, 120, null, 3);
  return newRoomId;
}

function createPrivateRoom(hostId, settings) {
  // Protect the server from DDOS! Strips out any maliciously injected words 
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
    safeCustomWords,
    Math.max(1, Math.min(4, parseInt(settings.hintLevel) || 2)),
    settings.password || null
  );
  return newRoomId;
}

function createRoomObject(id, isPrivate, hostId, maxPlayers, maxRounds, drawTime, customWords = null, hintLevel = 2, password = null) {
  return {
    id, isPrivate, hostId, maxPlayers, maxRounds, drawTime, hintLevel, password,
    players: {}, currentWord: "", currentDrawerId: null,
    gameState: 'waiting', timeRemaining: 0, endsAt: 0, timerInterval: null, 
    drawingHistory: [], drawingRevision: 0, 
    afkTimeout: null, currentRound: 1, drawQueue: [], priorityQueue: [], activeVotes: {},
    correctGuessers: [], turnScores: {}, underdogs: [],
    customWords: customWords, 
    availableWords: customWords && customWords.length > 0 ? [...customWords, ...wordList] : [...wordList]
  };
}

function broadcastPlayers(io, roomId) {
  const room = rooms[roomId];
  if (room) io.to(roomId).emit('update_players', Object.values(room.players));
}

module.exports = {
  getOrCreatePublicRoom,
  createPrivateRoom,
  createRoomObject,
  broadcastPlayers
};