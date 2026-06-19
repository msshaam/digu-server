const assert = require('assert');
const { shuffle, isMeld, findDiguMelds, scoreHand } = require('../gameLogic');
const { getVoteOutcome } = require('../disconnectVoteLogic');
const {
  getDiscardDestination,
  getInitialHandSize,
  getInitialTurnPhase,
  getDealerIndexForStartingPlayer,
  getRandomStartingPlayerIndex,
  shouldReshuffleAfterDeckDraw
} = require('../fivePlayerRules');

function card(rank, suit) {
  return { rank, suit, id: `${rank}${suit}` };
}

function testShufflePreservesCards() {
  const cards = [card('A', '♠'), card('2', '♠'), card('3', '♠'), card('4', '♠')];
  const shuffled = shuffle(cards);
  assert.strictEqual(shuffled.length, cards.length);
  assert.deepStrictEqual(
    shuffled.map(c => c.id).sort(),
    cards.map(c => c.id).sort()
  );
  assert.notStrictEqual(shuffled, cards);
}

function testMeldExportsStillWork() {
  assert.strictEqual(isMeld([card('3', '♠'), card('3', '♥'), card('3', '♦')]), true);
  assert.strictEqual(isMeld([card('2', '♣'), card('3', '♣'), card('4', '♣')]), true);
  assert.strictEqual(isMeld([card('4', '♣'), card('5', '♣'), card('6', '♣')]), true);
  assert.strictEqual(isMeld([card('A', '♣'), card('2', '♣'), card('3', '♣')]), false);
}

function testFindDiguMelds() {
  const hand = [
    card('3', '♠'), card('3', '♥'), card('3', '♦'),
    card('4', '♠'), card('4', '♥'), card('4', '♦'),
    card('7', '♣'), card('8', '♣'), card('9', '♣'), card('10', '♣')
  ];
  const melds = findDiguMelds(hand);
  assert.ok(melds);
  assert.deepStrictEqual(melds.map(group => group.length), [3, 3, 4]);
}

function testBestDiguMelds() {
  const hand = [
    card('6', '♦'), card('7', '♦'), card('8', '♦'),
    card('5', '♥'), card('5', '♣'), card('5', '♠'),
    card('6', '♠'), card('7', '♠'), card('8', '♠'), card('9', '♠')
  ];
  const melds = findDiguMelds(hand);
  assert.ok(melds);
  assert.deepStrictEqual(melds.map(group => group.map(c => c.id)), [
    ['6♦', '7♦', '8♦'],
    ['5♠', '5♥', '5♣'],
    ['6♠', '7♠', '8♠', '9♠']
  ]);
  assert.strictEqual(scoreHand(hand, false).meldPoints, 66);
}

function testPureSequenceBonus() {
  const hand = [
    card('2', '♦'), card('3', '♦'), card('4', '♦'), card('5', '♦'), card('6', '♦'),
    card('7', '♦'), card('8', '♦'), card('9', '♦'), card('10', '♦'), card('J', '♦')
  ];
  const score = scoreHand(hand, true);
  assert.strictEqual(score.netScore, 1000);
  assert.strictEqual(score.specialType, 'pureSequence10');
  assert.deepStrictEqual(score.nonMeldCards, []);
}

function testNoMeldPenalty() {
  const hand = [
    card('2', '♣'), card('5', '♣'), card('8', '♣'),
    card('3', '♥'), card('Q', '♥'), card('K', '♥'),
    card('A', '♣'), card('7', '♠'), card('8', '♠'), card('9', '♣')
  ];
  const score = scoreHand(hand, false);
  assert.strictEqual(score.netScore, -100);
  assert.strictEqual(score.noMeldPenalty, 100);
  assert.deepStrictEqual(score.melds, []);
}

function testDisconnectVoteOutcomeWaitsOnTie() {
  const outcome = getVoteOutcome({
    votes: { a: 'yes', b: 'no' },
    connectedPlayerIds: ['a', 'b'],
  });

  assert.strictEqual(outcome.yesVotes, 1);
  assert.strictEqual(outcome.noVotes, 1);
  assert.strictEqual(outcome.totalVoters, 2);
  assert.strictEqual(outcome.decided, true);
  assert.strictEqual(outcome.result, 'wait');
}

function testFivePlayerDeckDrawDiscardsBackToDeck() {
  assert.strictEqual(getDiscardDestination({ playerCount: 5, drawnCardSource: 'deck' }), 'deck');
}

function testFivePlayerDiscardDrawDiscardsBackToDiscardPile() {
  assert.strictEqual(getDiscardDestination({ playerCount: 5, drawnCardSource: 'discard' }), 'discard');
}

function testFourPlayerDeckDrawStillDiscardsToDiscardPile() {
  assert.strictEqual(getDiscardDestination({ playerCount: 4, drawnCardSource: 'deck' }), 'discard');
}

function testFivePlayerStarterGetsElevenCardsAndStartsDiscarding() {
  assert.strictEqual(getInitialHandSize({ playerCount: 5, isStartingPlayer: true }), 11);
  assert.strictEqual(getInitialHandSize({ playerCount: 5, isStartingPlayer: false }), 10);
  assert.strictEqual(getInitialTurnPhase(5), 'discard');
}

function testFourPlayerRoundStillStartsWithDraw() {
  assert.strictEqual(getInitialHandSize({ playerCount: 4, isStartingPlayer: true }), 10);
  assert.strictEqual(getInitialTurnPhase(4), 'draw');
}

function testFivePlayerDeckDoesNotReshuffleImmediatelyAfterLastCardDrawn() {
  assert.strictEqual(shouldReshuffleAfterDeckDraw({ playerCount: 5, deckCount: 0, discardCount: 8 }), false);
}

function testFourPlayerDeckStillReshufflesAfterLastCardDrawn() {
  assert.strictEqual(shouldReshuffleAfterDeckDraw({ playerCount: 4, deckCount: 0, discardCount: 8 }), true);
}

function testDealerIndexCanMakeSpecificPlayerStart() {
  assert.strictEqual(getDealerIndexForStartingPlayer({ playerCount: 5, startingPlayerIndex: 0 }), 1);
  assert.strictEqual(getDealerIndexForStartingPlayer({ playerCount: 5, startingPlayerIndex: 4 }), 0);
}

function testRandomStartingPlayerUsesAllPlayerSlots() {
  assert.strictEqual(getRandomStartingPlayerIndex(5, () => 0), 0);
  assert.strictEqual(getRandomStartingPlayerIndex(5, () => 0.999), 4);
}

testShufflePreservesCards();
testMeldExportsStillWork();
testFindDiguMelds();
testBestDiguMelds();
testPureSequenceBonus();
testNoMeldPenalty();
testDisconnectVoteOutcomeWaitsOnTie();
testFivePlayerDeckDrawDiscardsBackToDeck();
testFivePlayerDiscardDrawDiscardsBackToDiscardPile();
testFourPlayerDeckDrawStillDiscardsToDiscardPile();
testFivePlayerStarterGetsElevenCardsAndStartsDiscarding();
testFourPlayerRoundStillStartsWithDraw();
testFivePlayerDeckDoesNotReshuffleImmediatelyAfterLastCardDrawn();
testFourPlayerDeckStillReshufflesAfterLastCardDrawn();
testDealerIndexCanMakeSpecificPlayerStart();
testRandomStartingPlayerUsesAllPlayerSlots();
console.log('phase1-rules tests passed');
