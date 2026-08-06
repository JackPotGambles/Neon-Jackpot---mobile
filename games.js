/*
  EASY GAME CATALOG
  -----------------
  Add a game by copying one object below and changing its values.
  Keep `art` as a simple lowercase id; it controls the card's color treatment
  (used only as a fallback — see `image` below).

  CUSTOM CARD IMAGES
  -------------------
  Set `image` to a path (e.g. "./art/keno.png") to use your own image as the
  entire card — no icon, no text label drawn on top of it, just your image.
  If you want the game's name visible on the card, bake it into the image
  itself. Leave `image` as "" to fall back to the built-in vector art.

  Recommended image size: 900×600px (3:2 ratio), PNG or WebP. Cards render
  at different sizes around the site (lobby grid, search results, Recent
  Wins strip) and are cropped to fill with object-fit: cover, so keep the
  important part of the artwork centered and avoid key details near the
  edges.
*/
window.GAME_CATALOG = [
  {
    id: "limbo",
    name: "Limbo",
    description: "Pick your multiplier and see how high the signal climbs.",
    tag: "Arcade",
    rating: "4.9",
    players: "1.9k playing",
    art: "limbo",
    image: "./art/limbo.png",
    available: true
  },
  {
    id: "dice",
    name: "Dice",
    description: "A clean, quick roll with a little room for a big swing.",
    tag: "Classic",
    rating: "4.8",
    players: "1.4k playing",
    art: "dice",
    image: "./art/dice.png",
    available: true
  },
  {
    id: "keno",
    name: "Keno",
    description: "Choose your numbers and watch the board light up.",
    tag: "Numbers",
    rating: "4.7",
    players: "986 playing",
    art: "keno",
    image: "./art/keno.png",
    available: true
  },
  {
    id: "blackjack",
    name: "Blackjack",
    description: "A timeless table game, reimagined for the neon room.",
    tag: "Table",
    rating: "4.8",
    players: "1.1k playing",
    art: "blackjack",
    image: "./art/blackjack.png",
    available: true
  },
  {
    id: "plinko",
    name: "Plinko",
    description: "Drop a puck, follow the bounce, and catch the landing.",
    tag: "Board",
    rating: "4.6",
    players: "742 playing",
    art: "plinko",
    image: "./art/plinko.png",
    available: true
  },
  {
    id: "war",
    name: "War",
    description: "High card takes it all in this quick head-to-head classic.",
    tag: "Classic",
    rating: "4.5",
    players: "512 playing",
    art: "war",
    image: "./art/war.png",
    available: true
  },
  {
    id: "crash",
    name: "Crash",
    description: "Cash out before the curve collapses. Nerve over luck.",
    tag: "Arcade",
    rating: "4.8",
    players: "1.6k playing",
    art: "crash",
    image: "./art/crash.png",
    available: true
  },
  {
    id: "chickencross",
    name: "Chicken Cross",
    description: "Hop lane to lane and bank your multiplier before you cross the line.",
    tag: "Arcade",
    rating: "4.7",
    players: "633 playing",
    art: "chickencross",
    image: "./art/chickencross.png",
    available: true
  },
  {
    id: "dragontower",
    name: "Dragon Tower",
    description: "Climb the tower one tile at a time — greed has a price.",
    tag: "Tower",
    rating: "4.6",
    players: "588 playing",
    art: "dragontower",
    image: "./art/dragontower.png",
    available: true
  },
  {
    id: "hilo",
    name: "Hilo",
    description: "Guess higher or lower and keep the streak alive.",
    tag: "Cards",
    rating: "4.5",
    players: "441 playing",
    art: "hilo",
    image: "./art/hilo.png",
    available: true
  },
  {
    id: "roulette",
    name: "Roulette",
    description: "Red, black, or a single number — spin the classic wheel.",
    tag: "Table",
    rating: "4.7",
    players: "897 playing",
    art: "roulette",
    image: "./art/roulette.png",
    available: true
  },
  {
    id: "flip",
    name: "Flip",
    description: "Heads or tails. Simple stakes, instant results.",
    tag: "Classic",
    rating: "4.4",
    players: "378 playing",
    art: "flip",
    image: "./art/flip.png",
    available: true
  },
  {
    id: "mines",
    name: "Mines",
    description: "Clear the grid tile by tile without setting one off.",
    tag: "Board",
    rating: "4.8",
    players: "1.3k playing",
    art: "mines",
    image: "./art/mines.png",
    available: true
  },
  {
    id: "moles",
    name: "Moles",
    description: "Pick your mole count, then whack your way to a bigger multiplier.",
    tag: "Arcade",
    rating: "4.7",
    players: "654 playing",
    art: "moles",
    image: "./art/moles.png",
    available: true
  },
  {
    id: "rockpaperscissors",
    name: "Rock Paper Scissors",
    description: "Beat the house streak by streak and cash out before you lose.",
    tag: "Arcade",
    rating: "4.6",
    players: "467 playing",
    art: "rockpaperscissors",
    image: "./art/rockpaperscissors.png",
    available: true
  },
  {
    id: "casebattles",
    name: "Case Battles",
    description: "Challenge a friend 1v1 — open matching cases live, biggest total wins the pot.",
    tag: "1v1",
    rating: "5.0",
    players: "Live now",
    art: "chickencross",
    image: "./art/casebattles.png",
    available: true
  }
];

// Slot titles are shown in their own "Slots" shelf, separate from the main Originals catalog.
window.SLOT_CATALOG = [
  {
    id: "aviamaster",
    name: "Aviamaster",
    description: "A soaring slot with rising multipliers on every reel.",
    tag: "Slot",
    rating: "4.6",
    players: "701 playing",
    art: "aviamaster",
    image: "./art/aviamaster.png",
    available: false
  }
];