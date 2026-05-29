const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createDeck, canDeclareDigu, findDiguMelds, scoreHand } = require('./gameLogic');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// rooms: { [roomCode]: RoomState }
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function createRoom(hostName, hostSocketId) {
  let code;
  do { code = generateRoomCode(); } while (rooms[code]);

  // Each player has a stable UUID (playerId) separate from socket.id
  const playerId = uuidv4();

  rooms[code] = {
    code,
    hostPlayerId: playerId, // stable, never changes
    players: [{
      playerId,           // stable UUID, used for session
      socketId: hostSocketId,  // changes on reconnect
      name: hostName,
      hand: [],
      connected: true
    }],
    status: 'waiting',
    deck: [],
    discardPile: [],
    currentTurn: 0,
    dealerIndex: 0,
    roundScores: [],
    totalScores: {},
    drawnCard: null,
    turnPhase: 'draw',
    winnerName: null,
  };
  return { room: rooms[code], playerId };
}

function getRoomSafeState(room, requestingPlayerId) {
  return {
    code: room.code,
    status: room.status,
    players: room.players.map(p => ({
      playerId: p.playerId,
      name: p.name,
      cardCount: p.hand.length,
      score: room.totalScores[p.playerId] || 0,
      connected: p.connected,
      hand: p.playerId === requestingPlayerId ? p.hand : undefined,
    })),
    discardPile: room.discardPile,
    deckCount: room.deck.length,
    currentTurn: room.currentTurn,
    dealerIndex: room.dealerIndex,
    turnPhase: room.turnPhase,
    drawnCard: room.turnPhase === 'discard' && room.players[room.currentTurn]?.playerId === requestingPlayerId
      ? room.drawnCard
      : null,
    roundScores: room.roundScores,
    winnerName: room.winnerName,
    hostPlayerId: room.hostPlayerId,
  };
}

function emitRoomToAll(room) {
  for (const player of room.players) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit('gameState', getRoomSafeState(room, player.playerId));
    }
  }
}

function startRound(room) {
  const deck = createDeck();
  for (const player of room.players) {
    player.hand = deck.splice(0, 10);
  }
  room.deck = deck;
  room.discardPile = [];
  room.drawnCard = null;
  room.turnPhase = 'draw';
  room.roundScores = [];
  room.winnerName = null;
  room.status = 'playing';
  const n = room.players.length;
  room.currentTurn = (room.dealerIndex - 1 + n) % n;
  emitRoomToAll(room);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ playerName }, cb) => {
    const { room, playerId } = createRoom(playerName, socket.id);
    socket.join(room.code);
    cb({ success: true, roomCode: room.code, playerId });
    emitRoomToAll(room);
  });

  socket.on('joinRoom', ({ roomCode, playerName }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.status !== 'waiting') return cb({ success: false, error: 'Game already in progress.' });
    if (room.players.length >= 5) return cb({ success: false, error: 'Room is full (max 5 players).' });
    if (room.players.find(p => p.name.toLowerCase() === playerName.toLowerCase())) {
      return cb({ success: false, error: 'Name already taken in this room.' });
    }

    const playerId = uuidv4();
    room.players.push({ playerId, socketId: socket.id, name: playerName, hand: [], connected: true });
    socket.join(roomCode);
    cb({ success: true, roomCode, playerId });
    emitRoomToAll(room);
  });

  // Rejoin — match by stable playerId, update socketId
  socket.on('rejoinRoom', ({ roomCode, playerId }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.playerId === playerId);
    if (!player) return cb({ success: false, error: 'Player not found.' });

    // Update socket reference
    player.socketId = socket.id;
    player.connected = true;

    // If this player was the host, keep hostPlayerId intact (it's stable)
    socket.join(roomCode);
    cb({ success: true, playerName: player.name });

    // Emit state directly to this socket immediately
    socket.emit('gameState', getRoomSafeState(room, playerId));
    // Notify others of reconnection
    emitRoomToAll(room);
  });

  socket.on('startGame', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.playerId !== room.hostPlayerId) return cb({ success: false, error: 'Only the host can start.' });
    if (room.players.length < 2) return cb({ success: false, error: 'Need at least 2 players.' });
    if (room.status !== 'waiting') return cb({ success: false, error: 'Game already started.' });

    room.totalScores = {};
    room.players.forEach(p => { room.totalScores[p.playerId] = 0; });
    room.dealerIndex = 0;
    startRound(room);
    cb({ success: true });
  });

  socket.on('drawFromDeck', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'draw') return cb({ success: false, error: 'Already drawn.' });
    if (room.deck.length === 0) return cb({ success: false, error: 'Deck is empty.' });

    const card = room.deck.pop();
    room.drawnCard = card;
    room.turnPhase = 'discard';
    cb({ success: true, card });
    emitRoomToAll(room);
  });

  socket.on('drawFromDiscard', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'draw') return cb({ success: false, error: 'Already drawn.' });
    if (room.discardPile.length === 0) return cb({ success: false, error: 'Discard pile is empty.' });

    const card = room.discardPile.pop();
    room.drawnCard = card;
    room.turnPhase = 'discard';
    cb({ success: true, card });
    emitRoomToAll(room);
  });

  socket.on('discardCard', ({ roomCode, cardId, isDiguDiscard }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'discard') return cb({ success: false, error: 'Draw a card first.' });

    const player = room.players[playerIdx];
    const drawnCard = room.drawnCard;
    const fullHand = [...player.hand, drawnCard];
    const discardIdx = fullHand.findIndex(c => c.id === cardId);
    if (discardIdx === -1) return cb({ success: false, error: 'Card not found.' });

    const discardedCard = fullHand[discardIdx];
    const newHand = fullHand.filter((_, i) => i !== discardIdx);

    if (isDiguDiscard) {
      if (!canDeclareDigu(newHand)) {
        return cb({ success: false, error: 'Your hand does not form valid melds (3-3-4).' });
      }
      player.hand = newHand;
      room.drawnCard = null;
      room.status = 'roundEnd';
      room.winnerName = player.name;

      room.roundScores = room.players.map(p => {
        const isWinner = p.playerId === player.playerId;
        const result = scoreHand(p.hand, isWinner);
        room.totalScores[p.playerId] = (room.totalScores[p.playerId] || 0) + result.netScore;
        return {
          playerId: p.playerId,
          playerName: p.name,
          hand: p.hand,
          melds: isWinner ? findDiguMelds(p.hand) : null,
          ...result,
          totalScore: room.totalScores[p.playerId],
        };
      });

      emitRoomToAll(room);
      return cb({ success: true, digu: true });
    }

    player.hand = newHand;
    room.drawnCard = null;
    room.discardPile.push(discardedCard);
    room.turnPhase = 'draw';
    const n = room.players.length;
    room.currentTurn = (room.currentTurn - 1 + n) % n;
    emitRoomToAll(room);
    cb({ success: true });
  });

  socket.on('nextRound', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.playerId !== room.hostPlayerId) return cb({ success: false, error: 'Only host can start next round.' });

    const n = room.players.length;
    room.dealerIndex = (room.dealerIndex - 1 + n) % n;
    startRound(room);
    cb({ success: true });
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        player.connected = false;
        emitRoomToAll(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Digu server running on port ${PORT}`));
