/*
  GIFTS.JS — peer-to-peer balance gifting (offline, no server)
  ==============================================================
  Lets one player send balance to a friend as a copy/paste code, with the
  code locked to that friend's Player ID so it can't be redeemed by anyone
  else's save file.

  READ THIS FIRST — WHAT THIS DOES AND DOES NOT PROTECT AGAINST
  ----------------------------------------------------------------
  This game has no server and no database — every check runs inside the
  redeemer's own browser, against their own save file. That has one
  unavoidable consequence: nothing client-side can stop a player from
  editing their OWN save (balance, Player ID, redeemed-gift list, etc.)
  directly in devtools/localStorage. That's true with or without this
  feature, and no amount of clever code changes it.

  What this module DOES reliably do:
    - A gift generated for Player ID "ABC123" will only be ACCEPTED by a
      save file whose own Player ID is "ABC123" — person B can't hand the
      code to person C and have C redeem it instead.
    - A gift can only be redeemed once — the Gift ID is remembered forever
      once used, even across closing/reopening the game.
    - A gift that's been altered in transit (a character changed while
      copy/pasting, a corrupted code, someone hand-editing the JSON) is
      detected and rejected via a checksum.

  What this checksum is NOT: it is not a cryptographic signature backed by
  a secret key, because there is no secret that could exist ONLY on a
  trusted server — this is a single-file offline game, so any key would
  ship inside code every player has. The checksum instead uses SHA-256
  over the gift's own contents purely to catch ACCIDENTAL corruption
  (typos, partial copy/paste, a stray character) — not to stop a
  motivated player from forging a gift for themselves in their own save.
  A player who really wants to cheat their own single-player save already
  can, the same way they could just call Shell.addBalance() from the
  console. This module's actual job is making friend-to-friend gifting
  behave correctly for everyone acting in good faith, and failing
  loudly/safely (never silently granting money) whenever something looks
  wrong.

  MODULES IN THIS FILE
  ----------------------
    GiftSerializer — turns a gift object into a copy/paste-able code and
                     back again. Owns the wire format.
    GiftGenerator  — builds a new gift (the "send" side): validates input,
                     stamps a unique Gift ID + timestamp, computes the
                     checksum, deducts the sender's balance immediately.
    GiftRedeemer   — validates and applies an incoming gift code (the
                     "receive" side): checksum, recipient match, replay
                     check, then credits the balance.
    SaveManager    — the only code that touches localStorage for gifts.
                     Owns the "redeemed Gift IDs" ledger so it survives
                     closing/reopening the game.
    GiftManager    — thin public facade wiring the above together; this
                     is the only thing the UI (gifts.html) talks to.

  INTEGRATION
  -------------
  Include this file after shell.js (it uses Shell.getBalance/addBalance
  and Shell.getPlayerProfile — see shell.js — for balance + identity):
    <script src="./shell.js"></script>
    <script src="./gifts.js"></script>

  This module keeps its own localStorage key and does not touch anything
  in shell.js directly except through Shell's public functions, so it
  won't interfere with resetAllProgress(), account sync codes, etc.
  unless you choose to wire it in (see the bottom of this file for notes
  on that).
*/

window.GiftManager = (() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------

  // Where redeemed Gift IDs are persisted. Kept as its own localStorage key
  // (rather than reusing an existing one) so it's easy to see/inspect/wipe
  // independently, and easy to add to Shell's SYNC_KEYS / resetAllProgress
  // list later if you want gifting history to travel with account sync.
  const REDEEMED_KEY = "nj_redeemed_gifts";

  // Sent-gift history, kept locally on the SENDER's save only, purely so
  // the "Send" tab can show "gifts you've sent" for reference. This is not
  // load-bearing for security — redemption never trusts this list.
  const SENT_KEY = "nj_sent_gifts";

  // A short human-readable prefix so gift codes are visually distinct from
  // promo codes / account sync codes in the same app.
  const CODE_PREFIX = "NJGIFT2:";

  // Field separator for the compact code format below. Safe to split on because every field
  // that goes into a code is restricted to characters that can never contain this: Player IDs
  // are alphanumeric only (see PLAYER_ID_PATTERN), the short gift ID is alphanumeric, and the
  // amount is a plain decimal number — none of them can ever contain "~".
  const FIELD_SEP = "~";

  // Player IDs in this game look like "TTQ7BMWDSPLKPITLXWUHK4GC4Y" — keep
  // validation loose (non-empty, reasonable length, no whitespace) rather
  // than hard-coding today's exact format, so it still works if that
  // format ever changes.
  const PLAYER_ID_PATTERN = /^[A-Za-z0-9]{6,64}$/;

  // Where saved gift-recipient contacts (Player ID -> a friendly name) are persisted, so the
  // Send tab can offer "pick a saved contact" instead of re-typing/re-pasting a long Player ID
  // every time. Purely a local convenience list — never trusted for anything security-related.
  const CONTACTS_KEY = "nj_gift_contacts";

  // ---------------------------------------------------------------------
  // Small local error type so the UI can distinguish "expected, show a
  // friendly message" failures from genuine bugs.
  // ---------------------------------------------------------------------
  class GiftError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "GiftError";
      this.code = code; // machine-readable reason, e.g. "ALREADY_REDEEMED"
    }
  }

  // ---------------------------------------------------------------------
  // SaveManager — the only module that reads/writes gift-related
  // localStorage. Everything else goes through here.
  // ---------------------------------------------------------------------
  class SaveManager {
    // Returns the Set of Gift IDs this save has already redeemed.
    static getRedeemedIds() {
      try {
        const raw = localStorage.getItem(REDEEMED_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr : []);
      } catch {
        // Corrupted storage shouldn't crash the game or, worse, silently
        // forget every previously-redeemed gift and allow replays — but
        // since we can't safely recover the true list, the safest failure
        // mode is "treat as empty and let SaveManager rebuild cleanly from
        // here on", accepting the (rare, storage-corruption-only) risk
        // over losing the whole page to an exception.
        return new Set();
      }
    }

    // Permanently marks a Gift ID as redeemed. Called exactly once, after
    // every other validation has already passed and the balance has been
    // credited — see GiftRedeemer.redeem().
    static markRedeemed(giftId) {
      const ids = SaveManager.getRedeemedIds();
      ids.add(giftId);
      localStorage.setItem(REDEEMED_KEY, JSON.stringify(Array.from(ids)));
    }

    static isRedeemed(giftId) {
      return SaveManager.getRedeemedIds().has(giftId);
    }

    // ---- sent-gift history (local convenience list, sender's save only) ----
    static getSentHistory() {
      try {
        const raw = localStorage.getItem(SENT_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return Array.isArray(arr) ? arr : [];
      } catch {
        return [];
      }
    }
    static addSentHistory(entry) {
      const list = SaveManager.getSentHistory();
      list.unshift(entry); // newest first
      // Keep this list from growing forever in localStorage.
      const trimmed = list.slice(0, 200);
      localStorage.setItem(SENT_KEY, JSON.stringify(trimmed));
    }
  }

  // ---------------------------------------------------------------------
  // ContactBook — saved gift-recipient contacts (Player ID + a friendly
  // name), purely a local convenience list. Not used for anything
  // security-related — redemption never trusts this data.
  // ---------------------------------------------------------------------
  class ContactBook {
    static getAll() {
      try {
        const raw = JSON.parse(localStorage.getItem(CONTACTS_KEY));
        return Array.isArray(raw) ? raw : [];
      } catch { return []; }
    }
    static save(list) {
      localStorage.setItem(CONTACTS_KEY, JSON.stringify(list));
    }
    // Adds a new contact, or renames an existing one with the same id.
    static upsert(id, name) {
      const cleanId = (id || "").trim().toUpperCase();
      if (!cleanId) return ContactBook.getAll();
      const cleanName = (name || "").trim() || cleanId;
      const list = ContactBook.getAll();
      const idx = list.findIndex((c) => c.id === cleanId);
      if (idx !== -1) list[idx].name = cleanName;
      else list.unshift({ id: cleanId, name: cleanName });
      ContactBook.save(list);
      return list;
    }
    static remove(id) {
      const cleanId = (id || "").trim().toUpperCase();
      const list = ContactBook.getAll().filter((c) => c.id !== cleanId);
      ContactBook.save(list);
      return list;
    }
    static find(id) {
      const cleanId = (id || "").trim().toUpperCase();
      return ContactBook.getAll().find((c) => c.id === cleanId) || null;
    }
  }

  // A short random id for each gift (was a full crypto.randomUUID() — 36 characters — now a
  // much shorter alphanumeric string). This is what let the gift CODE itself shrink so much:
  // the old code base64-encoded a full JSON object (long keys, a 36-char UUID, a 64-char SHA-256
  // hex checksum, and a timestamp) which bloated a ~250-byte payload into a ~340+ character
  // blob. None of that verbosity added any real security for a client-side single-player demo —
  // see the big comment at the top of this file — so it's trimmed down below while keeping the
  // one thing that actually matters: a checksum that catches accidental corruption AND makes it
  // meaningfully inconvenient to hand-edit a code to claim more money (see computeChecksum).
  function shortGiftId(len = 9) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let s = "";
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }

  // ---------------------------------------------------------------------
  // Checksum helper — SHA-256 over the gift's canonical contents, via the
  // browser's built-in Web Crypto API (crypto.subtle). See the big comment
  // at the top of this file for exactly what this can and can't guarantee.
  //
  // Truncated to 12 hex characters (48 bits) rather than the full 64-char
  // digest. A full SHA-256 hex string is complete overkill for this use
  // case — nobody is trying to defeat this cryptographically, they're at
  // most hand-editing a pasted code — and 48 bits is still ample to catch
  // both accidental corruption (typos, partial copy/paste) and make
  // "just change the amount and recompute" infeasible without knowing the
  // exact truncation/canonicalization scheme, while keeping the code
  // dramatically shorter.
  // ---------------------------------------------------------------------
  async function computeChecksum(payload) {
    // Canonical string of the fields that matter — if any of these change, the checksum
    // changes. Deliberately excludes the checksum field itself. Order matters here since this
    // is a plain joined string, not a keyed object — every caller must pass fields in this
    // exact order (giftId, senderId, recipientId, amount).
    const canonical = [payload.giftId, payload.senderId, payload.recipientId, payload.amount].join("|");
    const bytes = new TextEncoder().encode(canonical);
    const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const full = hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
    return full.slice(0, 12);
  }

  // ---------------------------------------------------------------------
  // GiftSerializer — object <-> portable code string.
  //
  // COMPACT FORMAT (v2): instead of base64-encoding a full JSON object,
  // the code is just its five fields joined with FIELD_SEP ("~") after a
  // short prefix — no base64 layer at all, since base64 only inflates
  // size by ~33% for zero benefit here (there's nothing binary to hide;
  // see computeChecksum above for what actually deters tampering).
  //   NJGIFT2:<recipientId>~<senderId>~<giftId>~<amount>~<checksum>
  // ---------------------------------------------------------------------
  class GiftSerializer {
    static encode(gift) {
      const parts = [gift.recipientId, gift.senderId, gift.giftId, String(gift.amount), gift.checksum];
      return CODE_PREFIX + parts.join(FIELD_SEP);
    }

    // Code string -> gift object. Throws GiftError("MALFORMED", ...) for
    // anything that isn't a well-formed gift, rather than returning null,
    // so callers get a consistent way to report *why* it failed.
    static decode(code) {
      if (typeof code !== "string") {
        throw new GiftError("MALFORMED", "That doesn't look like a gift code.");
      }
      const trimmed = code.trim();
      if (!trimmed) {
        throw new GiftError("MALFORMED", "Paste a gift code first.");
      }
      const withoutPrefix = trimmed.startsWith(CODE_PREFIX)
        ? trimmed.slice(CODE_PREFIX.length)
        : trimmed; // tolerate codes pasted without the prefix

      const parts = withoutPrefix.split(FIELD_SEP);
      if (parts.length !== 5) {
        throw new GiftError("MALFORMED", "This gift code is corrupted or incomplete.");
      }
      const [recipientId, senderId, giftId, amountStr, checksum] = parts;
      const gift = { recipientId, senderId, giftId, amount: parseFloat(amountStr), checksum };

      GiftSerializer.assertShape(gift);
      return gift;
    }

    // Structural validation — every required field present and the right
    // basic type. This runs BEFORE the checksum check, so a gift that's
    // missing fields is reported as "malformed" rather than a confusing
    // checksum failure.
    static assertShape(gift) {
      if (!gift || typeof gift !== "object") {
        throw new GiftError("MALFORMED", "This gift code is corrupted or incomplete.");
      }
      const requiredStrings = ["giftId", "senderId", "recipientId", "checksum"];
      for (const key of requiredStrings) {
        if (typeof gift[key] !== "string" || !gift[key]) {
          throw new GiftError("MALFORMED", "This gift code is corrupted or incomplete.");
        }
      }
      if (typeof gift.amount !== "number" || !isFinite(gift.amount) || gift.amount <= 0) {
        throw new GiftError("MALFORMED", "This gift code is corrupted or incomplete.");
      }
    }
  }

  // ---------------------------------------------------------------------
  // GiftGenerator — the "send" side.
  // ---------------------------------------------------------------------
  class GiftGenerator {
    // Validates the input, deducts the sender's balance IMMEDIATELY (per
    // spec: money leaves the sender's balance the moment the gift is
    // created, not when/if it's ever redeemed), and returns the finished
    // gift code. Throws GiftError on any validation failure — nothing is
    // deducted if validation fails.
    static async create({ recipientId, amount }) {
      const senderId = Shell.getPlayerProfile().id;
      const cleanRecipientId = (recipientId || "").trim().toUpperCase();
      const cleanAmount = Math.round(parseFloat(amount) * 100) / 100;

      // ---- validate recipient ID ----
      if (!cleanRecipientId) {
        throw new GiftError("INVALID_RECIPIENT", "Enter your friend's Player ID.");
      }
      if (!PLAYER_ID_PATTERN.test(cleanRecipientId)) {
        throw new GiftError("INVALID_RECIPIENT", "That Player ID doesn't look right.");
      }
      if (cleanRecipientId === senderId.toUpperCase()) {
        throw new GiftError("SELF_GIFT", "You can't send a gift to your own Player ID.");
      }

      // ---- validate amount ----
      if (!cleanAmount || isNaN(cleanAmount) || cleanAmount <= 0) {
        throw new GiftError("INVALID_AMOUNT", "Enter an amount greater than 0.");
      }
      const currentBalance = Shell.getCashBalance();
      if (cleanAmount > currentBalance) {
        throw new GiftError("INSUFFICIENT_BALANCE", "You don't have enough balance to send that much.");
      }

      // ---- build the gift ----
      // giftId no longer needs to be a globally-unique-forever UUID — it only needs to be
      // unique enough that two gifts from the same sender don't collide, which a short random
      // alphanumeric string comfortably provides. Timestamp is deliberately left OUT of the
      // coded payload/checksum (redemption never needs it) — it's recorded only in the local
      // sent-history below, purely for the sender's own reference in the History tab.
      const giftId = shortGiftId();
      const timestamp = Date.now();
      const payload = { giftId, senderId, recipientId: cleanRecipientId, amount: cleanAmount };
      const checksum = await computeChecksum(payload);
      const gift = { ...payload, checksum };

      // ---- deduct immediately, per spec ----
      // This happens only after every validation above has passed, and
      // right before we hand back the code — so a thrown error above
      // never touches the balance.
      Shell.addCashBalance(-cleanAmount);

      // ---- record locally for the sender's own "sent gifts" reference ----
      SaveManager.addSentHistory({ giftId, recipientId: cleanRecipientId, amount: cleanAmount, timestamp });

      // ---- remember this recipient for next time, so the Send tab can offer it as a saved
      // contact without overwriting a name the player may have already given it ----
      if (!ContactBook.find(cleanRecipientId)) ContactBook.upsert(cleanRecipientId, cleanRecipientId);

      const code = GiftSerializer.encode(gift);
      return { code, gift };
    }
  }

  // ---------------------------------------------------------------------
  // GiftRedeemer — the "receive" side.
  // ---------------------------------------------------------------------
  class GiftRedeemer {
    // Runs every check in order, credits the balance only if ALL of them
    // pass, and only then marks the gift as redeemed. Throws GiftError
    // (with a .code you can branch on) on any failure; never partially
    // applies a gift.
    static async redeem(code) {
      // 1) Decode + structural validation (throws MALFORMED).
      const gift = GiftSerializer.decode(code);

      // 2) Checksum — catches corruption/edits before we trust any field.
      const expectedChecksum = await computeChecksum(gift);
      if (expectedChecksum !== gift.checksum) {
        throw new GiftError("TAMPERED", "This gift code appears to be corrupted or altered.");
      }

      // 3) Recipient match — the whole point of the lock. Case-insensitive
      // since Player IDs are uppercase-only anyway, but compare safely.
      const myId = Shell.getPlayerProfile().id;
      if (gift.recipientId.toUpperCase() !== myId.toUpperCase()) {
        throw new GiftError("WRONG_RECIPIENT", "This gift isn't addressed to your Player ID.");
      }

      // 4) Replay check — already redeemed on THIS save?
      if (SaveManager.isRedeemed(gift.giftId)) {
        throw new GiftError("ALREADY_REDEEMED", "Gift already redeemed.");
      }

      // 5) Sanity check on amount (defense in depth — assertShape already
      // checked this, but re-check right before granting money).
      if (!(gift.amount > 0)) {
        throw new GiftError("INVALID_AMOUNT", "This gift code is corrupted or incomplete.");
      }

      // ---- every check passed: credit the balance, THEN persist the
      // redeemed-ID record. Order matters for correctness under a crash
      // between the two lines, but since both are synchronous localStorage/
      // in-memory writes in a single-threaded page, there's no real gap in
      // practice; the ordering below just keeps "money granted implies
      // gift will be remembered as redeemed" as the natural reading. ----
      Shell.addCashBalance(gift.amount);
      SaveManager.markRedeemed(gift.giftId);

      return { amount: gift.amount, senderId: gift.senderId, giftId: gift.giftId };
    }
  }

  // ---------------------------------------------------------------------
  // Public facade — this is what gifts.html (or any other page) calls.
  // Keeps the class internals above swappable without touching the UI.
  // ---------------------------------------------------------------------
  async function createGift({ recipientId, amount }) {
    return GiftGenerator.create({ recipientId, amount });
  }

  async function redeemGift(code) {
    return GiftRedeemer.redeem(code);
  }

  function getSentHistory() {
    return SaveManager.getSentHistory();
  }

  function isRedeemed(giftId) {
    return SaveManager.isRedeemed(giftId);
  }

  // ---- saved contacts (Player ID -> friendly name) ----
  function getContacts() {
    return ContactBook.getAll();
  }
  function saveContact(id, name) {
    return ContactBook.upsert(id, name);
  }
  function removeContact(id) {
    return ContactBook.remove(id);
  }
  function findContact(id) {
    return ContactBook.find(id);
  }

  return {
    createGift,
    redeemGift,
    getSentHistory,
    isRedeemed,
    getContacts,
    saveContact,
    removeContact,
    findContact,
    GiftError,
    // exposed mainly for testing/inspection — the UI should stick to the
    // functions above:
    _internal: { GiftSerializer, GiftGenerator, GiftRedeemer, SaveManager, ContactBook },
  };
})();

/*
  OPTIONAL — wiring into Shell's account-sync / reset-progress lists
  ----------------------------------------------------------------------
  Right now REDEEMED_KEY ("nj_redeemed_gifts") and SENT_KEY ("nj_sent_gifts")
  live outside Shell's SYNC_KEYS list in shell.js, which means:
    - "Reset progress" (Shell.resetAllProgress) will NOT clear your
      redeemed-gifts ledger — on purpose, so resetting your balance/stats
      can't be used to "un-redeem" and re-redeem the same gift code.
    - Exporting/importing an account sync code will NOT carry redeemed-
      gift history to the new device — a code redeemed on device A could
      be redeemed again after importing that save on device B. If you
      want gifting history to travel with account sync, add both keys to
      the SYNC_KEYS array near the top of shell.js.
*/