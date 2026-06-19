const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { createDeck, shuffle, canDeclareDigu, findDiguMelds, scoreHand } = require('./gameLogic');
const { getVoteOutcome } = require('./disconnectVoteLogic');
const {
  getDiscardDestination,
  getInitialHandSize,
  getInitialTurnPhase,
  getDealerIndexForStartingPlayer,
  getRandomStartingPlayerIndex,
  shouldReshuffleAfterDeckDraw
} = require('./fivePlayerRules');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// rooms: { [roomCode]: RoomState }
const rooms = {};

const MAX_CHAT_MESSAGES = 200;
const MAX_CHAT_LENGTH = 300;

function pushChatMessage(room, { playerId, playerName, text }) {
  const message = {
    id: uuidv4(),
    playerId,
    playerName,
    text,
    timestamp: Date.now(),
  };
  room.chatMessages = room.chatMessages || [];
  room.chatMessages.push(message);
  if (room.chatMessages.length > MAX_CHAT_MESSAGES) {
    room.chatMessages = room.chatMessages.slice(-MAX_CHAT_MESSAGES);
  }
  return message;
}

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
      connected: true,
      disconnectedAt: null
    }],
    status: 'waiting',
    deck: [],
    discardPile: [],
    currentTurn: 0,
    dealerIndex: 0,
    roundScores: [],
    totalScores: {},
    scoreHistory: [],
    drawnCard: null,
    drawnCardSource: null,
    turnPhase: 'draw',
    winnerName: null,
    lastDiguCallerId: null,
    lastAction: null,
    actionSeq: 0,
    interruptionReason: null,
    scoreSnapshot: [],
    disconnectVote: null,
    chatMessages: [],
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
    scoreHistory: room.scoreHistory || [],
    currentTurn: room.currentTurn,
    dealerIndex: room.dealerIndex,
    turnPhase: room.turnPhase,
    drawnCard: room.turnPhase === 'discard' && room.players[room.currentTurn]?.playerId === requestingPlayerId
      ? room.drawnCard
      : null,
    roundScores: room.roundScores,
    winnerName: room.winnerName,
    hostPlayerId: room.hostPlayerId,
    interruptionReason: room.interruptionReason || null,
    scoreSnapshot: room.scoreSnapshot && room.scoreSnapshot.length > 0
      ? room.scoreSnapshot
      : buildScoreSnapshot(room),
    disconnectVote: getDisconnectVoteState(room, requestingPlayerId),
    drawnCardSource: room.turnPhase === 'discard' && room.players[room.currentTurn]?.playerId === requestingPlayerId
      ? room.drawnCardSource
      : null,
    lastAction: room.lastAction || null,
  };
}

function setLastAction(room, action) {
  room.actionSeq = (room.actionSeq || 0) + 1;
  room.lastAction = { id: room.actionSeq, ...action };
}

function emitRoomToAll(room) {
  for (const player of room.players) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit('gameState', getRoomSafeState(room, player.playerId));
    }
  }
}

function getConnectedPlayers(room) {
  return room.players.filter(p => p.connected);
}

function assignHostIfNeeded(room, preferredPlayerId = null) {
  if (room.players.length === 0) {
    room.hostPlayerId = null;
    return;
  }
  const preferredPlayer = room.players.find(p => p.playerId === preferredPlayerId);
  if (preferredPlayer?.connected) {
    room.hostPlayerId = preferredPlayerId;
    return;
  }
  const currentHost = room.players.find(p => p.playerId === room.hostPlayerId);
  if (currentHost?.connected) {
    return;
  }
  const connectedPlayer = room.players.find(p => p.connected);
  room.hostPlayerId = (connectedPlayer || room.players[0]).playerId;
}

function buildScoreSnapshot(room) {
  return room.players.map(p => ({
    playerId: p.playerId,
    playerName: p.name,
    totalScore: room.totalScores[p.playerId] || 0,
    connected: p.connected,
  }));
}

function enterInterruptedState(room, reason, scoreSnapshot = null) {
  room.status = 'interrupted';
  room.interruptionReason = reason;
  room.roundScores = [];
  room.scoreSnapshot = scoreSnapshot || buildScoreSnapshot(room);
  room.drawnCard = null;
  room.drawnCardSource = null;
  room.turnPhase = 'draw';
  room.disconnectVote = null;
}

function resetScores(room) {
  room.totalScores = {};
  room.players.forEach(p => {
    room.totalScores[p.playerId] = 0;
  });
}

function removePlayer(room, playerId) {
  const currentPlayerId = room.players[room.currentTurn]?.playerId;
  const dealerPlayerId = room.players[room.dealerIndex]?.playerId;
  const idx = room.players.findIndex(p => p.playerId === playerId);
  if (idx === -1) return { removed: null, index: -1 };

  const removed = room.players.splice(idx, 1)[0];
  if (room.players.length === 0) {
    room.currentTurn = 0;
    room.dealerIndex = 0;
    return { removed, index: idx };
  }

  const fallbackIndex = Math.min(idx, room.players.length - 1);
  const currentIndex = room.players.findIndex(p => p.playerId === currentPlayerId);
  const dealerIndex = room.players.findIndex(p => p.playerId === dealerPlayerId);

  room.currentTurn = currentIndex === -1 ? fallbackIndex : currentIndex;
  room.dealerIndex = dealerIndex === -1 ? fallbackIndex : dealerIndex;

  return { removed, index: idx };
}

function removeLongDisconnectedPlayers(room) {
  const now = Date.now();
  const removed = [];
  const currentPlayerId = room.players[room.currentTurn]?.playerId;
  const dealerPlayerId = room.players[room.dealerIndex]?.playerId;
  const previousCurrentTurn = room.currentTurn;
  const previousDealerIndex = room.dealerIndex;

  for (let i = room.players.length - 1; i >= 0; i--) {
    const player = room.players[i];
    if (!player.connected && player.disconnectedAt && now - player.disconnectedAt >= 5 * 60 * 1000) {
      removed.push(player);
      room.players.splice(i, 1);
    }
  }

  if (room.players.length === 0) {
    room.currentTurn = 0;
    room.dealerIndex = 0;
  } else {
    const currentIndex = room.players.findIndex(p => p.playerId === currentPlayerId);
    const dealerIndex = room.players.findIndex(p => p.playerId === dealerPlayerId);
    room.currentTurn = currentIndex === -1 ? Math.min(previousCurrentTurn, room.players.length - 1) : currentIndex;
    room.dealerIndex = dealerIndex === -1 ? Math.min(previousDealerIndex, room.players.length - 1) : dealerIndex;
  }

  assignHostIfNeeded(room);
  return removed.reverse();
}

function nextRemainingPlayerInTurnOrder(room, removedIndex) {
  if (room.players.length === 0) return null;
  const index = (removedIndex - 1 + room.players.length) % room.players.length;
  return room.players[index].playerId;
}

function closeRoom(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  for (const player of room.players) {
    const sock = io.sockets.sockets.get(player.socketId);
    if (sock) {
      sock.emit('roomClosed');
      sock.leave(roomCode);
    }
  }
  delete rooms[roomCode];
}

function getDisconnectVoteState(room, requestingPlayerId) {
  const now = Date.now();
  const eligibleDisconnected = room.players
    .filter(p => !p.connected && p.disconnectedAt && now - p.disconnectedAt >= 5 * 60 * 1000)
    .map(p => ({ playerId: p.playerId, name: p.name }));

  if (room.status !== 'playing' || eligibleDisconnected.length === 0) return null;
  if (room.disconnectVote?.cooldownUntil && room.disconnectVote.cooldownUntil > now) return null;

  const connected = getConnectedPlayers(room);
  if (room.players.length === 2 && connected.length === 1) {
    return {
      mode: 'twoPlayerEnd',
      eligible: true,
      disconnectedPlayers: eligibleDisconnected,
    };
  }

  const votes = room.disconnectVote?.votes || {};
  const voteOutcome = getVoteOutcome({
    votes,
    connectedPlayerIds: connected.map(p => p.playerId),
  });

  return {
    mode: 'vote',
    eligible: true,
    disconnectedPlayers: eligibleDisconnected,
    myVote: votes[requestingPlayerId] || null,
    yesVotes: voteOutcome.yesVotes,
    noVotes: voteOutcome.noVotes,
    votedCount: voteOutcome.votedCount,
    connectedCount: voteOutcome.totalVoters,
    totalVoters: voteOutcome.totalVoters,
    majority: voteOutcome.majority,
  };
}

function scheduleDisconnectVoteCheck(roomCode, playerId) {
  setTimeout(() => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players.find(p => p.playerId === playerId);
    if (!player || player.connected || !player.disconnectedAt) return;
    const voteState = getDisconnectVoteState(room, playerId);
    if (voteState?.eligible) emitRoomToAll(room);
  }, 5 * 60 * 1000);
}

function scheduleDisconnectVoteCooldown(roomCode) {
  setTimeout(() => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;
    const voteState = getDisconnectVoteState(room, room.hostPlayerId);
    if (voteState?.eligible) emitRoomToAll(room);
  }, 5 * 60 * 1000);
}

function startRound(room) {
  const deck = createDeck();
  const n = room.players.length;
  const startingPlayerIndex = (room.dealerIndex - 1 + n) % n;
  for (const player of room.players) {
    const isStartingPlayer = room.players.indexOf(player) === startingPlayerIndex;
    player.hand = deck.splice(0, getInitialHandSize({ playerCount: n, isStartingPlayer }));
  }
  room.deck = deck;
  room.discardPile = [];
  room.drawnCard = null;
  room.drawnCardSource = n === 5 ? 'opening' : null;
  room.turnPhase = getInitialTurnPhase(n);
  room.roundScores = [];
  room.winnerName = null;
  room.lastAction = null;
  room.status = 'playing';
  room.interruptionReason = null;
  room.scoreSnapshot = [];
  room.disconnectVote = null;
  room.currentTurn = startingPlayerIndex;
  emitRoomToAll(room);
}

io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createRoom', ({ playerName }, cb) => {
    const { room, playerId } = createRoom(playerName, socket.id);
    socket.join(room.code);
    cb({ success: true, roomCode: room.code, playerId });
    socket.emit('chatHistory', room.chatMessages || []);
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
    room.players.push({ playerId, socketId: socket.id, name: playerName, hand: [], connected: true, disconnectedAt: null });
    socket.join(roomCode);
    cb({ success: true, roomCode, playerId });
    socket.emit('chatHistory', room.chatMessages || []);
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
    player.disconnectedAt = null;
    room.disconnectVote = null;

    // If this player was the host, keep hostPlayerId intact (it's stable)
    socket.join(roomCode);
    cb({ success: true, playerName: player.name });

    // Emit state directly to this socket immediately
    socket.emit('gameState', getRoomSafeState(room, playerId));
    socket.emit('chatHistory', room.chatMessages || []);
    // Notify others of reconnection
    emitRoomToAll(room);
  });

  socket.on('leaveRoom', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: true, closed: true });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return cb({ success: true, closed: true });

    if (room.status === 'waiting') {
      const wasHost = player.playerId === room.hostPlayerId;
      removePlayer(room, player.playerId);
      socket.leave(roomCode);

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return cb({ success: true, closed: true });
      }

      if (wasHost) assignHostIfNeeded(room);
      emitRoomToAll(room);
      return cb({ success: true, left: true });
    }

    if (room.status === 'playing') {
      const wasHost = player.playerId === room.hostPlayerId;
      const { removed, index } = removePlayer(room, player.playerId);
      socket.leave(roomCode);

      if (room.players.length === 0) {
        delete rooms[roomCode];
        return cb({ success: true, closed: true });
      }

      if (wasHost) assignHostIfNeeded(room, nextRemainingPlayerInTurnOrder(room, index));
      enterInterruptedState(room, `${removed.name} left the game.`);
      emitRoomToAll(room);
      return cb({ success: true, left: true, forfeited: true });
    }

    const wasHost = player.playerId === room.hostPlayerId;
    removePlayer(room, player.playerId);
    socket.leave(roomCode);

    if (room.players.length === 0) {
      delete rooms[roomCode];
      return cb({ success: true, closed: true });
    }

    if (wasHost) assignHostIfNeeded(room);
    room.scoreSnapshot = buildScoreSnapshot(room);
    emitRoomToAll(room);
    return cb({ success: true, left: true });
  });

  socket.on('startGame', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.playerId !== room.hostPlayerId) return cb({ success: false, error: 'Only the host can start.' });
    if (room.players.length < 2) return cb({ success: false, error: 'Need at least 2 players.' });
    if (room.status !== 'waiting') return cb({ success: false, error: 'Game already started.' });

    room.totalScores = {};
    room.scoreHistory = [];
    room.players.forEach(p => { room.totalScores[p.playerId] = 0; });
    room.dealerIndex = room.players.length === 5
      ? getDealerIndexForStartingPlayer({
          playerCount: room.players.length,
          startingPlayerIndex: getRandomStartingPlayerIndex(room.players.length),
        })
      : 0;
    room.lastDiguCallerId = null;
    startRound(room);
    cb({ success: true });
  });

  socket.on('drawFromDeck', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.status !== 'playing') return cb({ success: false, error: 'Game is not in progress.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'draw') return cb({ success: false, error: 'Already drawn.' });
    if (room.deck.length === 0) {
      if (room.discardPile.length === 0) {
        return cb({ success: false, error: 'Deck and discard pile are empty.' });
      }
      room.deck = shuffle(room.discardPile);
      room.discardPile = [];
    }

    const card = room.deck.pop();
    if (shouldReshuffleAfterDeckDraw({
      playerCount: room.players.length,
      deckCount: room.deck.length,
      discardCount: room.discardPile.length,
    })) {
      room.deck = shuffle(room.discardPile);
      room.discardPile = [];
    }
    room.drawnCard = card;
    room.drawnCardSource = 'deck';
    room.turnPhase = 'discard';
    setLastAction(room, { type: 'draw', source: 'deck', playerId: room.players[playerIdx].playerId, card: null });
    cb({ success: true, card });
    emitRoomToAll(room);
  });

  socket.on('drawFromDiscard', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.status !== 'playing') return cb({ success: false, error: 'Game is not in progress.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'draw') return cb({ success: false, error: 'Already drawn.' });
    if (room.discardPile.length === 0) return cb({ success: false, error: 'Discard pile is empty.' });

    const card = room.discardPile.pop();
    room.drawnCard = card;
    room.drawnCardSource = 'discard';
    room.turnPhase = 'discard';
    setLastAction(room, { type: 'draw', source: 'discard', playerId: room.players[playerIdx].playerId, card });
    cb({ success: true, card });
    emitRoomToAll(room);
  });

  socket.on('putBackDiscard', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.status !== 'playing') return cb({ success: false, error: 'Game is not in progress.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'discard') return cb({ success: false, error: 'No card to put back.' });
    if (room.drawnCardSource !== 'discard' || !room.drawnCard) {
      return cb({ success: false, error: 'Only a card taken from discard can be put back.' });
    }

    room.discardPile.push(room.drawnCard);
    setLastAction(room, { type: 'putBack', source: 'discard', playerId: room.players[playerIdx].playerId, card: room.drawnCard });
    room.drawnCard = null;
    room.drawnCardSource = null;
    room.turnPhase = 'draw';
    emitRoomToAll(room);
    cb({ success: true });
  });

  socket.on('discardCard', ({ roomCode, cardId, isDiguDiscard }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    if (room.status !== 'playing') return cb({ success: false, error: 'Game is not in progress.' });
    const playerIdx = room.players.findIndex(p => p.socketId === socket.id);
    if (playerIdx !== room.currentTurn) return cb({ success: false, error: 'Not your turn.' });
    if (room.turnPhase !== 'discard') return cb({ success: false, error: 'Draw a card first.' });

    const player = room.players[playerIdx];
    const drawnCard = room.drawnCard;
    const isOpeningDiscard = room.drawnCardSource === 'opening';
    const fullHand = drawnCard ? [...player.hand, drawnCard] : player.hand;
    const discardIdx = fullHand.findIndex(c => c.id === cardId);
    if (discardIdx === -1) return cb({ success: false, error: 'Card not found.' });

    const discardedCard = fullHand[discardIdx];
    const newHand = fullHand.filter((_, i) => i !== discardIdx);

    // Block returning the same card that was taken from the discard pile
    if (!isDiguDiscard && room.drawnCardSource === 'discard' && room.drawnCard && discardedCard.id === room.drawnCard.id) {
      return cb({ success: false, error: 'You cannot discard the card you just took from the discard pile.' });
    }

    if (isDiguDiscard) {
      if (isOpeningDiscard) {
        return cb({ success: false, error: 'Discard the opening extra card before calling Digu.' });
      }
      if (!canDeclareDigu(newHand)) {
        return cb({ success: false, error: 'Your hand does not form valid melds (3-3-4).' });
      }
      player.hand = newHand;
      room.drawnCard = null;
      room.drawnCardSource = null;
      room.status = 'roundEnd';
      room.winnerName = player.name;
      room.lastDiguCallerId = player.playerId;

      room.roundScores = room.players.map(p => {
        const isWinner = p.playerId === player.playerId;
        const result = scoreHand(p.hand, isWinner);
        room.totalScores[p.playerId] = (room.totalScores[p.playerId] || 0) + result.netScore;
        return {
          playerId: p.playerId,
          playerName: p.name,
          hand: p.hand,
          melds: result.melds,
          nonMeldCards: result.nonMeldCards,
          ...result,
          totalScore: room.totalScores[p.playerId],
        };
      });
      room.scoreHistory = room.scoreHistory || [];
      room.scoreHistory.push({
        roundNumber: room.scoreHistory.length + 1,
        winnerPlayerId: player.playerId,
        winnerName: player.name,
        scores: room.roundScores.map(s => ({
          playerId: s.playerId,
          playerName: s.playerName,
          netScore: s.netScore,
          totalScore: s.totalScore,
        })),
      });

      emitRoomToAll(room);
      return cb({ success: true, digu: true });
    }

    const discardDestination = getDiscardDestination({
      playerCount: room.players.length,
      drawnCardSource: room.drawnCardSource,
    });

    player.hand = newHand;
    room.drawnCard = null;
    room.drawnCardSource = null;
    if (discardDestination === 'deck') {
      room.deck.push(discardedCard);
      room.deck = shuffle(room.deck);
    } else {
      room.discardPile.push(discardedCard);
    }
    setLastAction(room, { type: 'discard', destination: discardDestination, playerId: player.playerId, card: discardedCard });
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
    if (room.status !== 'roundEnd') return cb({ success: false, error: 'Round has not ended.' });

    const n = room.players.length;
    const diguCallerIndex = room.players.findIndex(p => p.playerId === room.lastDiguCallerId);
    room.dealerIndex = diguCallerIndex === -1
      ? (room.dealerIndex - 1 + n) % n
      : (diguCallerIndex + 1) % n;
    startRound(room);
    cb({ success: true });
  });

  socket.on('startNewGame', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.playerId !== room.hostPlayerId) return cb({ success: false, error: 'Only host can start a new game.' });
    if (room.players.length < 2) return cb({ success: false, error: 'Need at least 2 players.' });
    if (room.status !== 'interrupted') return cb({ success: false, error: 'Game is not interrupted.' });

    resetScores(room);
    room.scoreHistory = [];
    room.dealerIndex = room.players.length === 5
      ? getDealerIndexForStartingPlayer({
          playerCount: room.players.length,
          startingPlayerIndex: getRandomStartingPlayerIndex(room.players.length),
        })
      : 0;
    room.lastDiguCallerId = null;
    startRound(room);
    cb({ success: true });
  });

  socket.on('endCurrentGame', ({ roomCode }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player || player.playerId !== room.hostPlayerId) {
      return cb({ success: false, error: 'Only the host can end the game.' });
    }
    if (room.status !== 'playing' && room.status !== 'roundEnd') {
      return cb({ success: false, error: 'Game is not in progress.' });
    }

    enterInterruptedState(room, `${player.name} ended the game.`, buildScoreSnapshot(room));
    emitRoomToAll(room);
    cb({ success: true });
  });

  socket.on('voteEndGame', ({ roomCode, vote }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return cb({ success: false, error: 'Player not found.' });
    if (room.status !== 'playing') return cb({ success: false, error: 'Game is not in progress.' });

    const voteState = getDisconnectVoteState(room, player.playerId);
    if (!voteState?.eligible) return cb({ success: false, error: 'No disconnect vote is available yet.' });

    if (voteState.mode === 'twoPlayerEnd') {
      const scoreSnapshot = buildScoreSnapshot(room);
      removeLongDisconnectedPlayers(room);
      enterInterruptedState(room, 'Disconnected player was removed.', scoreSnapshot);
      emitRoomToAll(room);
      return cb({ success: true, ended: true });
    }

    if (vote !== 'yes' && vote !== 'no') return cb({ success: false, error: 'Vote must be yes or no.' });
    if (!room.disconnectVote) room.disconnectVote = { votes: {} };
    if (room.disconnectVote.cooldownUntil && room.disconnectVote.cooldownUntil > Date.now()) {
      return cb({ success: false, error: 'Disconnect vote is waiting before it can be shown again.' });
    }
    room.disconnectVote.votes[player.playerId] = vote;

    const voteOutcome = getVoteOutcome({
      votes: room.disconnectVote.votes,
      connectedPlayerIds: getConnectedPlayers(room).map(p => p.playerId),
    });

    if (voteOutcome.result === 'end') {
      const scoreSnapshot = buildScoreSnapshot(room);
      removeLongDisconnectedPlayers(room);
      enterInterruptedState(room, 'Disconnected players were removed.', scoreSnapshot);
      emitRoomToAll(room);
      return cb({ success: true, ended: true });
    }

    if (voteOutcome.result === 'wait') {
      room.disconnectVote = {
        votes: {},
        cooldownUntil: Date.now() + 5 * 60 * 1000,
      };
      scheduleDisconnectVoteCooldown(roomCode);
      emitRoomToAll(room);
      return cb({ success: true, waiting: true });
    }

    emitRoomToAll(room);
    return cb({ success: true });
  });

  socket.on('sendChatMessage', ({ roomCode, text }, cb) => {
    const room = rooms[roomCode];
    if (!room) return cb?.({ success: false, error: 'Room not found.' });
    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) return cb?.({ success: false, error: 'Player not found.' });

    const trimmed = (text || '').trim().slice(0, MAX_CHAT_LENGTH);
    if (!trimmed) return cb?.({ success: false, error: 'Message is empty.' });

    const message = pushChatMessage(room, { playerId: player.playerId, playerName: player.name, text: trimmed });
    io.to(roomCode).emit('chatMessage', message);
    cb?.({ success: true });
  });

  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      const player = room.players.find(p => p.socketId === socket.id);
      if (player) {
        player.connected = false;
        player.disconnectedAt = Date.now();
        room.disconnectVote = null;
        scheduleDisconnectVoteCheck(code, player.playerId);
        emitRoomToAll(room);
        break;
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`Digu server running on port ${PORT}`));
