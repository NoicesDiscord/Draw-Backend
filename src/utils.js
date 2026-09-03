// --- Secure Hint Engine ---
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
     revealedChars[idx] = room.currentWord[idx].toUpperCase();
  });
  return revealedChars;
}

// --- Typo Detection (Levenshtein Distance) ---
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

// --- Network Security & Validation ---
const isValidNum = (val, min, max) => typeof val === 'number' && Number.isFinite(val) && val >= min && val <= max;
const isValidDrawData = (data) => data && isValidNum(data.x, -200, 1000) && isValidNum(data.y, -200, 800); 
const isValidSize = (size) => isValidNum(size, 1, 100);
const validateColor = (c) => (typeof c === 'string' && c.length <= 25) ? c.substring(0, 25) : '#000000';

const checkRateLimit = (player) => {
  if (!player) return false;
  const now = Date.now();
  if (now - player.lastPacketReset > 1000) {
    player.packetsThisSecond = 0;
    player.lastPacketReset = now;
  }
  player.packetsThisSecond++;
  return player.packetsThisSecond <= 40; 
};

module.exports = {
  getRevealedChars,
  getEditDistance,
  isValidDrawData,
  isValidSize,
  validateColor,
  checkRateLimit
};