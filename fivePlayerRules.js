function getDiscardDestination({ playerCount, drawnCardSource }) {
  if (playerCount === 5 && drawnCardSource === 'deck') return 'deck';
  return 'discard';
}

function getInitialHandSize({ playerCount, isStartingPlayer }) {
  return playerCount === 5 && isStartingPlayer ? 11 : 10;
}

function getInitialTurnPhase(playerCount) {
  return playerCount === 5 ? 'discard' : 'draw';
}

function shouldReshuffleAfterDeckDraw({ playerCount, deckCount, discardCount }) {
  if (playerCount === 5) return false;
  return deckCount === 0 && discardCount > 0;
}

function getDealerIndexForStartingPlayer({ playerCount, startingPlayerIndex }) {
  return (startingPlayerIndex + 1) % playerCount;
}

function getRandomStartingPlayerIndex(playerCount, random = Math.random) {
  return Math.floor(random() * playerCount);
}

module.exports = {
  getDiscardDestination,
  getInitialHandSize,
  getInitialTurnPhase,
  getDealerIndexForStartingPlayer,
  getRandomStartingPlayerIndex,
  shouldReshuffleAfterDeckDraw
};
