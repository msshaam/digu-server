// Card values
const CARD_VALUE = (rank) => {
  if (rank === 'A') return 15;
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  return parseInt(rank);
};

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['♠', '♥', '♦', '♣'];
const RANK_ORDER = { 'A': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13 };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, id: `${rank}${suit}` });
    }
  }
  return shuffle(deck);
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardValue(card) {
  return CARD_VALUE(card.rank);
}

// Check if array of cards forms a valid run (consecutive same suit, min 3)
function isRun(cards) {
  if (cards.length < 3) return false;
  const suit = cards[0].suit;
  if (!cards.every(c => c.suit === suit)) return false;
  const sorted = [...cards].sort((a, b) => RANK_ORDER[a.rank] - RANK_ORDER[b.rank]);
  for (let i = 1; i < sorted.length; i++) {
    if (RANK_ORDER[sorted[i].rank] !== RANK_ORDER[sorted[i - 1].rank] + 1) return false;
  }
  return true;
}

// Check if array of cards forms a valid set (same rank, different suits, min 3)
function isSet(cards) {
  if (cards.length < 3) return false;
  const rank = cards[0].rank;
  if (!cards.every(c => c.rank === rank)) return false;
  const suits = cards.map(c => c.suit);
  return new Set(suits).size === suits.length; // all different suits
}

function isMeld(cards) {
  return isRun(cards) || isSet(cards);
}

// Try all combinations to find a valid 3-3-4 partition
function findDiguMelds(hand) {
  if (hand.length !== 10) return null;

  // Generate all ways to pick 3 cards from hand
  function combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const [first, ...rest] = arr;
    const withFirst = combinations(rest, k - 1).map(c => [first, ...c]);
    const withoutFirst = combinations(rest, k);
    return [...withFirst, ...withoutFirst];
  }

  const indices = hand.map((_, i) => i);

  // Try all splits of 10 cards into groups of 3, 3, 4
  const threes1 = combinations(indices, 3);
  for (const g1 of threes1) {
    if (!isMeld(g1.map(i => hand[i]))) continue;
    const remaining1 = indices.filter(i => !g1.includes(i));
    const threes2 = combinations(remaining1, 3);
    for (const g2 of threes2) {
      if (!isMeld(g2.map(i => hand[i]))) continue;
      const g3 = remaining1.filter(i => !g2.includes(i));
      if (g3.length === 4 && isMeld(g3.map(i => hand[i]))) {
        return [
          g1.map(i => hand[i]),
          g2.map(i => hand[i]),
          g3.map(i => hand[i])
        ];
      }
    }
  }
  return null;
}

function canDeclareDigu(hand) {
  return findDiguMelds(hand) !== null;
}

// Score a player's hand after digu is declared
// Returns { meldPoints, nonMeldPoints, netScore }
function scoreHand(hand, isDiguCaller) {
  const melds = findDiguMelds(hand);
  let meldPoints = 0;
  let nonMeldPoints = 0;

  if (melds) {
    for (const meld of melds) {
      for (const card of meld) {
        meldPoints += cardValue(card);
      }
    }
  } else {
    // Try to find any valid partial melds to count as profit
    // Find best partial meld coverage
    const { meldCards, nonMeldCards } = findPartialMelds(hand);
    for (const card of meldCards) meldPoints += cardValue(card);
    for (const card of nonMeldCards) nonMeldPoints += cardValue(card);
  }

  const bonus = isDiguCaller ? 100 : 0;
  return {
    meldPoints,
    nonMeldPoints,
    netScore: meldPoints - nonMeldPoints + bonus,
    bonus
  };
}

// Find best partial meld coverage greedily
function findPartialMelds(hand) {
  const used = new Set();
  const melds = [];

  function combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const [first, ...rest] = arr;
    return [
      ...combinations(rest, k - 1).map(c => [first, ...c]),
      ...combinations(rest, k)
    ];
  }

  // Try sizes 4 then 3
  for (const size of [4, 3]) {
    const available = hand.map((_, i) => i).filter(i => !used.has(i));
    const combos = combinations(available, size);
    for (const combo of combos) {
      if (isMeld(combo.map(i => hand[i]))) {
        combo.forEach(i => used.add(i));
        melds.push(combo.map(i => hand[i]));
        break;
      }
    }
  }

  const meldCards = [...used].map(i => hand[i]);
  const nonMeldCards = hand.filter((_, i) => !used.has(i));
  return { meldCards, nonMeldCards };
}

module.exports = {
  createDeck,
  cardValue,
  canDeclareDigu,
  findDiguMelds,
  scoreHand,
  isMeld
};
