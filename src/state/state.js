const fs = require('fs');
const path = require('path');

// Global Constants
const PUBLIC_MAX_PLAYERS = 8;

// In-Memory Data Stores
const rooms = {}; 
const disconnectTimeouts = {}; 
const offlinePlayers = {}; 

// Load the word dictionary safely
const wordsCsvPath = path.join(__dirname, '../../words.csv');
let wordList = [];

try {
  wordList = fs.readFileSync(wordsCsvPath, 'utf8')
    .split(',') 
    .map(w => w.trim()) 
    .filter(w => w.length > 0); 
} catch (error) {
  console.error("⚠️ Failed to load words.csv! Please ensure it exists in the root directory.", error);
}

module.exports = {
  PUBLIC_MAX_PLAYERS,
  rooms,
  disconnectTimeouts,
  offlinePlayers,
  wordList
};