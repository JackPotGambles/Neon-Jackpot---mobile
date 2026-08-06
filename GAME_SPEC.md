# New game spec — fill this in, then hand it + `_game-template.html` to an AI

Copy this file, answer every line, then paste the finished answers into a
chat along with `_game-template.html` and say:

> "Fill in `_game-template.html` using this spec. Keep everything about the
> shell, sidebar wiring, bet log, modals, and stats panel exactly as-is —
> only replace the game logic and the stage visuals. Output the finished
> file as `./<gameid>.html`."

That's the whole prompt. You don't need to re-explain the site's shared
chrome, balance system, or bet log every time — the template already wires
all of that up correctly.

---

## 1. Identity

- **Game name** (shown in title bar / lobby card): 
- **Game id** (lowercase, no spaces, matches filename — e.g. `dice`, `keno`): 
- **One-line description** (for the lobby card, ~10 words): 
- **Catalog tag** (e.g. "Classic", "Arcade", "Table", "Board"): 

## 2. Core rules

- **What does the player choose before betting?** (a number, a multiplier
  target, a set of tiles, cards, nothing extra — just describe it):

- **What determines win vs. lose?** (be exact — this is the logic the AI
  will implement):

- **How is the payout multiplier calculated?** (formula, or a fixed table
  of outcome → multiplier):

- **Is there a house edge built in, and if so how much / where does it
  live in the math?** (e.g. "true odds x0.99", "RTP ~97%"):

- **Any auto-bet / auto-play behavior needed, or manual-only for now?**

## 3. Visuals ("the stage")

- **What should the play area look like at rest** (before betting)?

- **What happens visually while a round resolves** (animation, reveal,
  countdown)? Roughly how long should it take?

- **What does a win look like? A loss?**

- **Any specific colors / theme note** (otherwise the AI will pick
  something consistent with the rest of the site — dark background,
  neon mint/pink/blue accents):

## 4. Sidebar controls

List every input the player needs beyond the standard bet-amount field
that's already in the template (e.g. "a target multiplier slider from
1.01x to 1000x", "a High/Low toggle", "a grid of 25 tiles to pick mines
from"). One line each:

-
-
-

## 5. Anything else unusual

Side bets, multi-step rounds (like blackjack's hit/stand), a grid/board
state, provably-fair seed display, or anything that doesn't fit the
simple "bet → instant result" loop the template stub demonstrates:



---

## What the AI should NOT change

- `Shell.mount(...)`, the `#site-sidebar` / `#site-topbar` / `#page-content`
  wrapper divs, and the `<script src="./shell.js">` / `<script
  src="./games.js">` tags.
- The requirement that every settled round calls `Shell.addBetEntry({ game,
  bet, won, profit })` exactly once — this drives rank progress, rakeback,
  the wager case, and the bets/stats pages sitewide. Skipping it or calling
  it more than once per round will cause the same kind of reward-tracking
  bug that was fixed in the wager case.
- The info/fair-play modal markup pattern, the settings popover pattern,
  and the live-stats panel — these can be restyled but should keep working
  the same way (open/close behavior, drag handle, chart).
- For any game where a placed bet stays "in progress" across more than one
  render — i.e. anything that isn't an instant bet→result game like Dice,
  Limbo, or Keno (Dragon Tower's row climb, Blackjack's hit/stand, or any
  future multi-step game) — the round MUST be persisted so navigating away
  by accident doesn't silently forfeit the bet:
  - Call `Shell.saveActiveRound(GAME_ID, data)` every time the round's
    state changes AFTER a bet has been placed (never for the idle/pre-bet
    screen — only save once money is actually on the table).
  - Call `Shell.clearActiveRound(GAME_ID)` the instant the round fully
    settles (win, loss, or cash-out) — before that point the round is
    still "in progress" and must stay saved.
  - On load, call `Shell.loadActiveRound(GAME_ID)` and, if it returns
    data, restore the round in place of the idle screen instead of
    starting fresh.
  - See `dragontower.html` (`persistRound`) and `blackjack.html`
    (`persistRound`, including how it snapshots the non-serializable
    `cardSeq` counter) for reference implementations.

## After the file is generated

1. Save it as `./<gameid>.html` next to the other game pages.
2. Add an entry to `GAME_CATALOG` in `games.js`:
   ```js
   {
     id: "<gameid>",
     name: "<Game Name>",
     description: "<one-line description>",
     tag: "<catalog tag>",
     rating: "4.5",
     players: "0 playing",
     art: "<gameid>",       // controls the lobby card's color treatment —
                             // add a matching `.game-art.<gameid>` rule in
                             // shell.css if you want a custom gradient/art,
                             // otherwise it falls back to the default look
     available: true
   }
   ```
3. If you want unique card art (like Limbo's chips or Blackjack's cards),
   add a small art block to `Shell.gameArtInner()` in `shell.js` and a
   matching CSS block in `shell.css`, following the existing games as
   examples.
