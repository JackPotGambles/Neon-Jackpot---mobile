/*
  SHELL.JS — shared site chrome
  -----------------------------
  Renders the persistent left sidebar + top bar used on every page
  (lobby and every game), and owns the single shared $ balance that
  is synced across tabs/pages via localStorage.

  Usage on any page:
    1. Add: <div class="site-shell"><div id="site-topbar"></div><div id="site-sidebar"></div><div id="page-content">...your page...</div></div>
    2. Call Shell.mount({ activeTab, onTab }) once on load.
    3. Use Shell.getBalance() / Shell.setBalance() / Shell.addBalance()
       to read/write the shared balance — never keep a local copy.
*/
window.Shell = (() => {
  const BALANCE_KEY = "nj_balance";
  const FAVORITES_KEY = "nj_favorites";
  const BETLOG_KEY = "nj_betlog";
  const DEFAULT_BALANCE = 0;
  const EARN_KEY = "nj_earn";
  const NOTIF_KEY = "nj_notifications";
  const RECENT_SEARCH_KEY = "nj_recent_searches";
  const VAULT_KEY = "nj_vault_balance";
  const REWARD_BALANCE_KEY = "nj_reward_balance"; // separate currency, funded only by promo/claim codes
  const ACTIVE_CURRENCY_KEY = "nj_active_currency"; // "cash" | "reward" — which balance games currently wager from
  const REWARD_LOCK_KEY = "nj_reward_lock"; // { totalClaimed, totalWagered } — gates reward->cash conversion
  const PLAYER_KEY = "nj_player";
  const CLAIM_KEY = "nj_claims";
  const CLAIM_TOTALS_KEY = "nj_claim_totals";
  const BOOST_KEY = "nj_boost_end";
  const RAFFLE_KEY = "nj_raffle";
  const GAME_RESETS_KEY = "nj_game_resets";   // stores { gameId: timestamp }
  const LIFETIME_WAGERED_KEY = "nj_lifetime_wagered"; // persists across "reset live stats" — drives rank & wheel spins
  const RAKEBACK_KEY = "nj_rakeback"; // { available: number, claimedTotal: number }
  const RECENT_WINS_KEY = "nj_recent_wins"; // independent of BETLOG_KEY so "reset live stats" never clears the lobby's Recent Wins strip
  const RAKEBACK_RATE = 0.005; // 0.5% of every wager accrues as rakeback
  const SIDEBAR_COLLAPSE_KEY = "nj_sidebar_collapsed";
  const ACTIVE_ROUND_KEY = "nj_active_round"; // { game: string, data: object } — an in-progress bet, restored on page load, cleared once a round settles
  const ANIMATIONS_DISABLED_KEY = "nj_animations_disabled"; // "1" when the global "Disable Animations" setting is on
  const AVATAR_IMAGE_KEY = "nj_avatar_image"; // compressed data-URL of the uploaded profile picture, if any
  const SESSION_KEY = "nj_session_active"; // sessionStorage (tab-only) — "0" after Logout, cleared/absent means logged in
  const DEV_KEY = "nj_developer"; // per-account: whether the secret dev code has been unlocked
  const APPEAR_OFFLINE_KEY = "nj_appear_offline"; // per-account: dev-only "invisible" toggle for presence
  const DEV_ENABLED_KEY = "nj_developer_enabled"; // per-account on/off switch, only meaningful once unlocked
  const DEV_SNAPSHOT_KEY = "nj_dev_snapshot"; // per-account: pre-dev-tools snapshot for "revert changes"
  const CASE_UPGRADE_KEY = "nj_case_upgrades"; // wager case Luck/Speed/Multiplier upgrade levels
  const LEGENDARY_CASE_OWNED_KEY = "nj_legendary_cases_owned"; // count of converted, unopened Legendary cases
  const EXOTIC_CASE_OWNED_KEY = "nj_exotic_cases_owned"; // count of converted, unopened Exotic cases
  const PROMO_REDEEMED_KEY = "nj_promo_redeemed"; // moved up from further down the file so it's declared before SYNC_KEYS references it
  const RAIL_DROPDOWN_KEY = "nj_rail_dropdowns"; // { originals: bool, slots: bool } — moved up from further down the file for the same reason
  const ACCOUNTS_KEY = "nj_accounts"; // { [username]: { password, snapshot: {...SYNC_KEYS data}, syncCodeClaimed?: true } } — NOT real security, this is a client-side demo with no server; password is stored as plain text the same way the old sync code was just a plain base64 blob
  
  // ---------- cloud accounts (Firebase) ----------
  // Same Firebase project chat.js already connects to. Copy the exact same
  // FIREBASE_CONFIG object you pasted into chat.js — it must match exactly.
  const CLOUD_FIREBASE_CONFIG = {
    apiKey: "AIzaSyBskecxdRn4bd9hTsysB5kxQUu0SPiriBc",
    authDomain: "neon-jackpot-264cb.firebaseapp.com",
    projectId: "neon-jackpot-264cb",
    databaseURL: "https://neon-jackpot-264cb-default-rtdb.firebaseio.com",
    storageBucket: "neon-jackpot-264cb.firebasestorage.app",
    messagingSenderId: "9058066447",
    appId: "1:9058066447:web:7900b7bd62b28187d1837a"
  };

  let cloudDb = null;
  function getCloudDb() {
    if (cloudDb) return cloudDb;
    if (typeof firebase === "undefined") return null; // SDK scripts not loaded on this page
    try {
      if (!firebase.apps.length) firebase.initializeApp(CLOUD_FIREBASE_CONFIG);
      cloudDb = firebase.database();
      return cloudDb;
    } catch {
      return null;
    }
  }

  // Pushes one account's {password, snapshot} up to Firebase under accounts/{username}.
  // Fire-and-forget — never blocks the UI, and silently no-ops if Firebase isn't reachable
  // (e.g. offline, or chat.js's SDK scripts aren't on this page).
  function cloudSaveAccount(username, acct) {
    const db = getCloudDb();
    if (!db || !username) return;
    db.ref("accounts/" + username).set(acct).catch((err) => {
      console.warn("Shell: couldn't save account to the cloud.", err);
    });
  }

  // Checks Firebase for a newer copy of the currently active account and, if the cloud
  // version is newer than what's on this device, loads it in. Called on every page load.
  async function pullLatestAccountIfNewer() {
    const username = getActiveAccountUsername();
    if (!username) return;
    liveAccountPullInFlight = true;
    try {
      const cloudAcct = await cloudFetchAccount(username);
      if (!cloudAcct) return;

      const accts = getAccounts();
      const localAcct = accts[username];
      const localSavedAt = (localAcct && localAcct.savedAt) || 0;
      const cloudSavedAt = cloudAcct.savedAt || 0;

      if (cloudSavedAt > localSavedAt) {
        loadSnapshotIntoLiveExceptMoney(cloudAcct.snapshot);
        accts[username] = cloudAcct;
        setAccounts(accts);
        document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
        document.dispatchEvent(new CustomEvent("nj:betlog", { detail: getBetLog() }));
        document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
      }
      liveAccountGen = Math.max(liveAccountGen, cloudSavedAt);
    } finally {
      liveAccountPullInFlight = false;
    }
  }

  // Whenever this tab goes from hidden back to visible, treat it exactly like a fresh
  // mount(): re-pull the latest cloud copy first, before anything in this tab is allowed to
  // push its own (possibly hours-stale) state back up. This is what closes the "phone tab
  // left open for hours while PC played" bug — without this, the phone tab's very next
  // 5-second autosave tick would blindly overwrite the PC's newer progress.
  function setupVisibilityResync() {
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (isLoggedOut()) return;
      pullLatestAccountIfNewer().then(() => {
        document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
        document.dispatchEvent(new CustomEvent("nj:vault", { detail: getVaultBalance() }));
        document.dispatchEvent(new CustomEvent("nj:betlog", { detail: getBetLog() }));
        document.dispatchEvent(new CustomEvent("nj:reward", { detail: getRewardBalance() }));
        document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
        // Repaint the chrome (balance/sidebar numbers) so what's on screen matches what was
        // just pulled in, without requiring a manual refresh.
        const topEl = document.querySelector("#site-topbar");
        const sideEl = document.querySelector("#site-sidebar");
        if (topEl) topEl.innerHTML = topbarHTML();
        if (sideEl) sideEl.innerHTML = sidebarHTML(document.querySelector(".rail-link.active")?.textContent?.trim() || "Lobby");
        bindChrome();
        document.dispatchEvent(new CustomEvent("nj:chrome-repainted"));
      });
    });
  }

  // Fetches one account from Firebase. Returns a Promise resolving to the account object
  // ({password, snapshot}) or null if it doesn't exist / Firebase isn't reachable.
  function cloudFetchAccount(username) {
    const db = getCloudDb();
    if (!db || !username) return Promise.resolve(null);
    return db.ref("accounts/" + username).once("value")
      .then((snap) => snap.val() || null)
      .catch((err) => {
        console.warn("Shell: couldn't fetch account from the cloud.", err);
        return null;
      });
  }

  // reward amounts + cooldowns (ms) for the daily/weekly/pre-monthly/monthly bonuses
  const REWARD_AMOUNTS = { daily: 1.75, weekly: 3.00, preMonthly: 2.00, monthly: 4.88 };
  const MIN_BET = 0.10; // smallest allowed real-money wager in any game; $0/blank is still allowed as a free demo bet
  // A bet amount is only checked against MIN_BET once the player has actually entered something
  // greater than 0 — an empty/zero field is demo mode (free play) and stays untouched.
  function isBelowMinBet(amount) {
    const n = parseFloat(amount);
    return !isNaN(n) && n > 0 && n < MIN_BET;
  }
  const REWARD_COOLDOWNS = { daily: 86400000, weekly: 604800000, preMonthly: 1296000000, monthly: 2592000000 };

  const svg = (name) => `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${({
    spark: '<path d="m12 3 1.8 6.2L20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8L12 3Z"/>',
    grid: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 16h16M10 4v16M16 4v16"/>',
    heart: '<path d="M20.8 8.8c0 5.2-8.8 10-8.8 10s-8.8-4.8-8.8-10A4.5 4.5 0 0 1 12 6.5a4.5 4.5 0 0 1 8.8 2.3Z"/>',
    activity: '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    rotate: '<path d="M4 12a8 8 0 0 1 14-5l2 2M20 12a8 8 0 0 1-14 5l-2-2"/><path d="M20 5v4h-4M4 19v-4h4"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2 2.5-2.5Z"/>',
    hamburger: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    home: '<path d="M4 11.5 12 4l8 7.5"/><path d="M6 10v9h5v-5h2v5h5v-9"/>',
    sparkles: '<path d="m12 3 1.4 4.6L18 9l-4.6 1.4L12 15l-1.4-4.6L6 9l4.6-1.4L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
    chevronDown: '<path d="m7 10 5 5 5-5"/>',
    chevronLeft: '<path d="m14 6-6 6 6 6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    gift: '<rect x="3" y="9" width="18" height="12" rx="1.5"/><path d="M3 9h18v4H3z"/><path d="M12 9v12"/><path d="M12 9c-1.4 0-4-1.1-4-3.2A2.8 2.8 0 0 1 10.5 3C12 3 12 6 12 9Z"/><path d="M12 9c1.4 0 4-1.1 4-3.2A2.8 2.8 0 0 0 13.5 3C12 3 12 6 12 9Z"/>',
    wallet: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h11A2.5 2.5 0 0 1 19 7.5V8H5.5A2.5 2.5 0 0 1 3 5.5Z"/><path d="M3 8h16a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/><circle cx="16.5" cy="13.5" r="1.2"/>',
    safe: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="12" cy="12" r="4.3"/><path d="M12 9v1.4M12 12h1.4"/><path d="M6.2 6.2v2.3M17.8 6.2v2.3M6.2 17.8v-2.3M17.8 17.8v-2.3"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    coin: '<circle cx="12" cy="12" r="9"/><path d="M9.5 15.5c0 1 1 1.8 2.5 1.8s2.5-.7 2.5-1.7c0-2.4-5-1.3-5-3.7 0-1 1-1.7 2.5-1.7s2.5.7 2.5 1.6"/><path d="M12 7.5v9"/>',
    bolt: '<path d="m13 2-9 12h6l-1 8 9-12h-6l1-8Z"/>',
    trend: '<path d="M3 17 9 11l4 4 8-9"/><path d="M15 6h6v6"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.5-6 8-6s8 2 8 6"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    cashcoin: '<circle cx="12" cy="12" r="9.5" fill="#3aeb8f" stroke="#1c9d5f" stroke-width="1"/><text x="12" y="16.2" font-family="Arial, sans-serif" font-size="12" font-weight="800" text-anchor="middle" fill="#04140f" stroke="none">$</text>',
    rewardcoin: '<circle cx="12" cy="12" r="9.5" fill="#b06bff" stroke="#7c3fd6" stroke-width="1"/><text x="12" y="16.2" font-family="Arial, sans-serif" font-size="12" font-weight="800" text-anchor="middle" fill="#1a0630" stroke="none">R</text>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  }[name] || '<circle cx="12" cy="12" r="8"/>')}</svg>`;

  // ---------- cash balance (the real-money balance — synced via localStorage across pages/tabs) ----------
  // This is the underlying store used by the vault, gifts, incremental upgrades, and anything
  // else that must always deal in real cash regardless of which currency the player has
  // selected for game wagering. Use these *Cash* functions explicitly for anything that should
  // never be payable with reward balance.
  function getCashBalance() {
    const raw = localStorage.getItem(BALANCE_KEY);
    const n = raw === null ? DEFAULT_BALANCE : parseFloat(raw);
    return isNaN(n) ? DEFAULT_BALANCE : n;
  }
  function setCashBalance(value) {
    const n = Math.max(0, Math.round(value * 100) / 100);
    localStorage.setItem(BALANCE_KEY, String(n));
    if (getActiveCurrency() === "cash") document.dispatchEvent(new CustomEvent("nj:balance", { detail: n }));
    bumpSyncFloor();
    syncLiveField("cash");
    return n;
  }
  function addCashBalance(delta) {
    return setCashBalance(getCashBalance() + delta);
  }
  function resetCashBalance() {
    return setCashBalance(DEFAULT_BALANCE);
  }

  // ---------- reward balance (a separate currency, funded only by promo/claim codes) ----------
  // Reward balance can only be spent on games/slots — never on vault deposits, gifts, or
  // incremental upgrades — and can only become real cash by wagering it through games first
  // (see the reward-lock section below) and then converting it via the Exchange Currency modal.
  function getRewardBalance() {
    const raw = localStorage.getItem(REWARD_BALANCE_KEY);
    const n = raw === null ? 0 : parseFloat(raw);
    return isNaN(n) ? 0 : n;
  }
  function setRewardBalance(value) {
    const n = Math.max(0, Math.round(value * 100) / 100);
    localStorage.setItem(REWARD_BALANCE_KEY, String(n));
    if (getActiveCurrency() === "reward") document.dispatchEvent(new CustomEvent("nj:balance", { detail: n }));
    document.dispatchEvent(new CustomEvent("nj:reward", { detail: n }));
    syncLiveField("reward");
    return n;
  }
  function addRewardBalance(delta) {
    return setRewardBalance(getRewardBalance() + delta);
  }
  function resetRewardBalance() {
    return setRewardBalance(0);
  }

  // ---------- active currency (which balance games currently wager from) ----------
  function getActiveCurrency() {
    const v = localStorage.getItem(ACTIVE_CURRENCY_KEY);
    return v === "reward" ? "reward" : "cash";
  }
  function setActiveCurrency(cur) {
    const clean = cur === "reward" ? "reward" : "cash";
    localStorage.setItem(ACTIVE_CURRENCY_KEY, clean);
    document.dispatchEvent(new CustomEvent("nj:currency", { detail: clean }));
    // the displayed balance now refers to a different pool of money — refresh it immediately
    document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
    return clean;
  }

  // ---------- reward wager-lock (gates how much reward balance can be converted to cash) ----------
  // A code redeemed for, say, +1000 reward balance adds 1000 to totalClaimed. That 1000 stays
  // locked until the player has WAGERED at least 1000 of reward balance through games — tracked
  // in totalWagered, bumped every time a bet is logged while reward is the active currency.
  // Converting cash out of reward balance requires totalWagered to have caught up to
  // totalClaimed at least once. Once that goal is met, the reward balance at that moment
  // becomes permanently unlocked ("unlockedAmount") — it stays convertible even if the player
  // later claims another code, since a new claim should only lock the NEW money, not re-lock
  // balance the player already earned the right to convert.
  //
  // When a new code is claimed:
  //   - If the previous goal hadn't been met yet, the new amount just extends the existing goal.
  //   - If the previous goal HAD been met, `unlockedAmount` is frozen at the reward balance right
  //     now (before the claim lands), and a brand new goal of just the new claim amount begins
  //     (totalClaimed/totalWagered reset to 0/newAmount's target). Only the new money needs to be
  //     wagered again; the frozen unlockedAmount stays convertible regardless.
  //   - unlockedAmount is capped to the player's current reward balance whenever read, so if the
  //     player gambles the unlocked balance away to zero, there's nothing left to convert until
  //     they meet a goal again.
  function getRewardLockState() {
    try {
      const raw = JSON.parse(localStorage.getItem(REWARD_LOCK_KEY));
      if (!raw || typeof raw !== "object") return { totalClaimed: 0, totalWagered: 0, unlockedAmount: 0 };
      return { totalClaimed: raw.totalClaimed || 0, totalWagered: raw.totalWagered || 0, unlockedAmount: raw.unlockedAmount || 0 };
    } catch { return { totalClaimed: 0, totalWagered: 0, unlockedAmount: 0 }; }
  }
  function setRewardLockState(s) {
    localStorage.setItem(REWARD_LOCK_KEY, JSON.stringify(s));
    document.dispatchEvent(new CustomEvent("nj:rewardlock", { detail: s }));
    return s;
  }
  function addRewardClaimed(amount, balanceBeforeClaim) {
    const amt = amount || 0;
    const s = getRewardLockState();
    if (s.totalWagered >= s.totalClaimed) {
      // Previous goal already met — freeze whatever was convertible right before this claim's
      // cash landed (not after), then start a fresh goal covering only the new claim.
      s.unlockedAmount = balanceBeforeClaim != null ? balanceBeforeClaim : Math.max(0, getRewardBalance() - amt);
      s.totalClaimed = amt;
      s.totalWagered = 0;
    } else {
      // Still working toward the existing goal — just add to it as before.
      s.totalClaimed += amt;
    }
    return setRewardLockState(s);
  }
  function addRewardWagered(amount) {
    if (!(amount > 0)) return getRewardLockState();
    const s = getRewardLockState();
    s.totalWagered += amount;
    return setRewardLockState(s);
  }
  function rewardGoalMet() {
    const s = getRewardLockState();
    return s.totalWagered >= s.totalClaimed;
  }
  // How much the player can convert to cash RIGHT NOW: the frozen unlockedAmount (capped to
  // however much reward balance is actually left — it disappears if gambled away), PLUS the
  // full remaining reward balance once the current goal is also met.
  function rewardConvertibleNow() {
    const s = getRewardLockState();
    const balance = getRewardBalance();
    const frozen = Math.min(s.unlockedAmount, balance);
    if (rewardGoalMet()) return balance;
    return Math.max(0, Math.min(frozen, balance));
  }
  // Converts `amount` of reward balance into cash balance, 1:1, if and only if that much is
  // currently unlocked. Returns the amount actually converted (0 if the request wasn't allowed).
  function convertRewardToCash(amount) {
    const amt = Math.round((amount || 0) * 100) / 100;
    if (!(amt > 0)) return 0;
    const max = rewardConvertibleNow();
    if (amt > max + 0.001) return 0;
    setRewardBalance(getRewardBalance() - amt);
    addCashBalance(amt);
    const s = getRewardLockState();
    if (rewardGoalMet()) {
      // Converting from a fully-met goal settles everything — reset clean so the next claim
      // starts a fresh 0/goal instead of stacking onto a stale, already-passed baseline.
      setRewardLockState({ totalClaimed: 0, totalWagered: 0, unlockedAmount: 0 });
    } else {
      // Converting from the frozen pre-unlocked amount — reduce what's left frozen, leave the
      // in-progress goal for the newer claim untouched.
      s.unlockedAmount = Math.max(0, s.unlockedAmount - amt);
      setRewardLockState(s);
    }
    return amt;
  }

  // ---------- public, currency-aware balance API ----------
  // Every game page calls Shell.getBalance()/setBalance()/addBalance() to place and settle bets.
  // These now transparently operate on whichever currency the player has selected (cash or
  // reward) so no per-game code changes are needed for the reward-balance feature to work.
  // Anything that must ALWAYS be cash-only (vault, gifts, incremental upgrades, dev tools) uses
  // the explicit *Cash* functions above instead.
  function getBalance() {
    return getActiveCurrency() === "reward" ? getRewardBalance() : getCashBalance();
  }
  function setBalance(value) {
    return getActiveCurrency() === "reward" ? setRewardBalance(value) : setCashBalance(value);
  }
  function addBalance(delta) {
    return getActiveCurrency() === "reward" ? addRewardBalance(delta) : addCashBalance(delta);
  }
  function resetBalance() {
    return getActiveCurrency() === "reward" ? resetRewardBalance() : resetCashBalance();
  }

  // ---------- full account reset (profile "Reset progress" button) ----------
  // Wipes every piece of persisted state — balance, vault, bet log, earn/incremental
  // progress, claims/rewards, notifications, favorites, boost, raffle wager — back to defaults.
  function resetAllProgress() {
    const keys = [
      BALANCE_KEY, VAULT_KEY, BETLOG_KEY, EARN_KEY, NOTIF_KEY, RECENT_SEARCH_KEY,
      CLAIM_KEY, CLAIM_TOTALS_KEY, BOOST_KEY, FAVORITES_KEY, RAFFLE_KEY,
      LIFETIME_WAGERED_KEY, RAKEBACK_KEY, RECENT_WINS_KEY, AVATAR_IMAGE_KEY,
      REWARD_BALANCE_KEY, ACTIVE_CURRENCY_KEY, REWARD_LOCK_KEY, CASE_UPGRADE_KEY,
    ];
    keys.forEach((k) => localStorage.removeItem(k));
    document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
    document.dispatchEvent(new CustomEvent("nj:vault", { detail: getVaultBalance() }));
    document.dispatchEvent(new CustomEvent("nj:betlog", { detail: [] }));
    document.dispatchEvent(new CustomEvent("nj:reward", { detail: getRewardBalance() }));
    document.dispatchEvent(new CustomEvent("nj:rewardlock", { detail: getRewardLockState() }));
    document.dispatchEvent(new CustomEvent("nj:currency", { detail: getActiveCurrency() }));
    return true;
  }

  // keep in sync if changed in another tab
  window.addEventListener("storage", (e) => {
    if (e.key === BALANCE_KEY || e.key === REWARD_BALANCE_KEY) document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
    if (e.key === ACTIVE_CURRENCY_KEY) document.dispatchEvent(new CustomEvent("nj:currency", { detail: getActiveCurrency() }));
  });

  // ---------- vault balance (separate stash, funded by moving money out of the main balance) ----------
  function getVaultBalance() {
    const raw = localStorage.getItem(VAULT_KEY);
    const n = raw === null ? 0 : parseFloat(raw);
    return isNaN(n) ? 0 : n;
  }
  function setVaultBalance(value) {
    const n = Math.max(0, Math.round(value * 100) / 100);
    localStorage.setItem(VAULT_KEY, String(n));
    document.dispatchEvent(new CustomEvent("nj:vault", { detail: n }));
    syncLiveField("vault");
    return n;
  }
  window.addEventListener("storage", (e) => {
    if (e.key === VAULT_KEY) document.dispatchEvent(new CustomEvent("nj:vault", { detail: getVaultBalance() }));
  });

  // ---------- player profile (id / name / member-since, generated once and persisted) ----------
  function genPlayerId() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let s = "";
    for (let i = 0; i < 26; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return "TT" + s.slice(2);
  }
  function getPlayerProfile() {
    try {
      let p = JSON.parse(localStorage.getItem(PLAYER_KEY));
      if (!p || !p.id) throw 0;
      if (!p.avatarColor) p.avatarColor = "#5cffe7";
      return p;
    } catch {
      const p = { id: genPlayerId(), name: "Nova", memberSince: Date.now(), avatarColor: "#5cffe7", avatarEmoji: "" };
      localStorage.setItem(PLAYER_KEY, JSON.stringify(p));
      return p;
    }
  }
  function setPlayerProfile(patch) {
    const p = { ...getPlayerProfile(), ...patch };
    localStorage.setItem(PLAYER_KEY, JSON.stringify(p));
    document.dispatchEvent(new CustomEvent("nj:player", { detail: p }));
    return p;
  }
  function avatarInitials(name) {
    return (name || "NV").trim().slice(0, 2).toUpperCase() || "NV";
  }
  function fmtMemberSince(ts) {
    return new Date(ts).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
  }

  // ---------- uploaded profile picture (compressed data-URL, stored alongside the rest of the profile) ----------
  function getAvatarImage() {
    return localStorage.getItem(AVATAR_IMAGE_KEY) || "";
  }
  function setAvatarImage(dataUrl) {
    if (dataUrl) localStorage.setItem(AVATAR_IMAGE_KEY, dataUrl);
    else localStorage.removeItem(AVATAR_IMAGE_KEY);
    document.dispatchEvent(new CustomEvent("nj:player", { detail: getPlayerProfile() }));
  }
  // Renders whatever the player currently has set as their avatar — an uploaded photo takes
  // priority over emoji/initials. Used everywhere the rail/topbar/profile avatar is painted.
  function avatarContentHTML(player) {
    const img = getAvatarImage();
    if (img) return `<img src="${img}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;" />`;
    return player.avatarEmoji || avatarInitials(player.name);
  }

  // ---------- global "Disable Animations" setting ----------
  function isAnimationsDisabled() {
    return localStorage.getItem(ANIMATIONS_DISABLED_KEY) === "1";
  }
  function setAnimationsDisabled(value) {
    if (value) localStorage.setItem(ANIMATIONS_DISABLED_KEY, "1");
    else localStorage.removeItem(ANIMATIONS_DISABLED_KEY);
    applyAnimationsClass();
    document.dispatchEvent(new CustomEvent("nj:animations", { detail: !!value }));
    return !!value;
  }
  function applyAnimationsClass() {
    document.documentElement.classList.toggle("nj-no-animations", isAnimationsDisabled());
  }
  window.addEventListener("storage", (e) => {
    if (e.key === ANIMATIONS_DISABLED_KEY) { applyAnimationsClass(); document.dispatchEvent(new CustomEvent("nj:animations", { detail: isAnimationsDisabled() })); }
  });

  // ---------- session / logout ----------
  // Logout is intentionally tab-only (sessionStorage): it clears nothing in localStorage (the
  // saved account — balance, bets, rank, profile, everything — stays intact) and just gates the
  // UI behind a login screen until the player logs back in. Closing the tab/browser naturally
  // "forgets" the logout since sessionStorage doesn't persist, matching "clears the current
  // session only" while "preserving the saved account".
  function isLoggedOut() {
    if (sessionStorage.getItem(SESSION_KEY) === "0") return true;
    // Brand-new browser/device that has never registered or logged into an account: force the
    // login gate instead of silently mounting the lobby on default/empty state. Once an account
    // has been created or logged into, ACTIVE_ACCOUNT_KEY is set and stays set from then on.
    if (!getActiveAccountUsername()) return true;
    return false;
  }
  function logout() {
    persistActiveAccount();
    sessionStorage.setItem(SESSION_KEY, "0");
  }
  function loginBackIn() {
    sessionStorage.removeItem(SESSION_KEY);
  }

  // ---------- account sync (login via Profile ID) ----------
  // Packs every piece of persisted state into one JSON blob keyed by the player's ID, then
  // base64-encodes it into a single portable "sync code". Pasting that code on another device/
  // browser (via importAccountCode) restores the exact same balance, bets, rank, rewards, etc.
  // This is entirely local — there's no server; the code IS the save file.
  const SYNC_KEYS = [
    BALANCE_KEY, VAULT_KEY, EARN_KEY, NOTIF_KEY, RECENT_SEARCH_KEY,
    PLAYER_KEY, CLAIM_KEY, CLAIM_TOTALS_KEY, BOOST_KEY, RAFFLE_KEY,
    LIFETIME_WAGERED_KEY, RAKEBACK_KEY, FAVORITES_KEY,
    DEV_KEY, DEV_ENABLED_KEY, DEV_SNAPSHOT_KEY,
    REWARD_BALANCE_KEY, ACTIVE_CURRENCY_KEY, REWARD_LOCK_KEY, CASE_UPGRADE_KEY,
    RECENT_WINS_KEY, RAIL_DROPDOWN_KEY, LEGENDARY_CASE_OWNED_KEY, EXOTIC_CASE_OWNED_KEY,
    "nj_sent_gifts",
    // NOTE: nj_redeemed_gifts is deliberately NOT in this list, for the same reason
    // PROMO_REDEEMED_KEY isn't. If gift-redemption history traveled with the account snapshot,
    // switching accounts before the periodic autosave writes it back (or reverting via dev tools)
    // could roll it back to a stale copy that doesn't yet contain a gift that was already
    // redeemed — letting the same gift code be redeemed again for free money. Keeping it outside
    // the snapshot means every account on this browser shares one redemption ledger, so a given
    // gift code can only ever be cashed in once on this device, no matter which account (or how
    // many account switches) happen in between.
  ];
  // ---------- sync "floor" — closes the stale-code replay exploit ----------
  // Deliberately stored OUTSIDE of SYNC_KEYS, so importing a code (which wipes and
  // replaces every SYNC_KEYS value) can never roll this back. Keyed per player ID.
  // The floor only ever moves forward: every real balance change bumps it to the
  // current timestamp (see setCashBalance), and export/import both stamp the code
  // with the floor's value at that moment. On import, a code whose stamp is older
  // than the floor already recorded for that ID is refused — which is exactly the
  // "copy a code while balance was $100k, drain the balance, paste the old code
  // back in to restore the $100k" replay. Since ordinary play keeps bumping the
  // floor forward (independent of whether anyone ever exports again), an old code
  // becomes unusable as soon as ANY balance-changing action happens after it was
  // copied — not just after a newer code is generated.
  // NOTE: this is a client-only demo with no server, so it trusts the browser's
  // own clock; it isn't unbeatable against someone manually editing localStorage,
  // but it closes the ordinary "save-scum with an old copied code" path.
  const SYNC_FLOOR_KEY = "nj_sync_floor"; // { [playerId]: highestTimestampSeenForThisId }
  function getSyncFloorMap() {
    try { return JSON.parse(localStorage.getItem(SYNC_FLOOR_KEY)) || {}; } catch { return {}; }
  }
  function setSyncFloorMap(m) { localStorage.setItem(SYNC_FLOOR_KEY, JSON.stringify(m)); }
  function bumpSyncFloor() {
    try {
      const id = getPlayerProfile().id;
      if (!id) return;
      const map = getSyncFloorMap();
      map[id] = Math.max(map[id] || 0, Date.now());
      setSyncFloorMap(map);
    } catch { /* best-effort; never block a balance update over this */ }
  }

  function exportAccountCode() {
    const data = {};
    SYNC_KEYS.forEach((k) => { const v = localStorage.getItem(k); if (v !== null) data[k] = v; });
    const id = getPlayerProfile().id;
    const map = getSyncFloorMap();
    const gen = Math.max(map[id] || 0, Date.now());
    map[id] = gen;
    setSyncFloorMap(map);
    const json = JSON.stringify({ v: 2, id, gen, data });
    try { return btoa(unescape(encodeURIComponent(json))); } catch { return ""; }
  }
  function importAccountCode(code) {
    try {
      const json = decodeURIComponent(escape(atob(code.trim())));
      const parsed = JSON.parse(json);
      if (!parsed || !parsed.data) return false;
      if (parsed.v >= 2 && parsed.id) {
        const map = getSyncFloorMap();
        const floor = map[parsed.id] || 0;
        if (typeof parsed.gen === "number" && parsed.gen < floor) {
          return "stale"; // stale code — this account has moved on since this code was copied
        }
        map[parsed.id] = Math.max(floor, parsed.gen || 0, Date.now());
        setSyncFloorMap(map);
      }
      SYNC_KEYS.forEach((k) => localStorage.removeItem(k));
      Object.entries(parsed.data).forEach(([k, v]) => localStorage.setItem(k, v));
      return true;
    } catch { return false; }
  }

  // ---------- username/password accounts ----------
  // Replaces sync codes as the primary way to move an account between devices/browsers.
  // A username+password pair is really just a friendlier, reusable stand-in for what a sync
  // code already did: logging in with the right credentials pulls that account's full saved
  // state (a SYNC_KEYS snapshot) down into the live localStorage keys, same mechanism
  // importAccountCode used. This is NOT real auth — there's no server, so the whole registry
  // (including the password, stored as plain text) lives in localStorage on whichever browser
  // currently holds it. That's the same trust model the old sync code already had — a sync
  // code was just a plaintext-in-base64 blob with zero real security either.
  function getAccounts() {
    try { return JSON.parse(localStorage.getItem(ACCOUNTS_KEY)) || {}; } catch { return {}; }
  }
  function setAccounts(accts) { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(accts)); }

  // Snapshot every SYNC_KEYS value currently live in localStorage into a plain object.
  function snapshotCurrentState() {
    const data = {};
    SYNC_KEYS.forEach((k) => { const v = localStorage.getItem(k); if (v !== null) data[k] = v; });
    return data;
  }
  // Load a previously-taken snapshot back into the live localStorage keys, replacing whatever
  // was there before (same "wipe then restore" approach importAccountCode uses).
  function loadSnapshotIntoLive(snapshot) {
    SYNC_KEYS.forEach((k) => localStorage.removeItem(k));
    Object.entries(snapshot || {}).forEach(([k, v]) => localStorage.setItem(k, v));
  }
  // Same as above, but never touches balance/vault/reward/lifetimeWagered — those are owned
  // exclusively by the real-time liveFields sync, which is always more accurate than a
  // periodic snapshot. This is what stops a stale snapshot from ever rolling back real money.
  function loadSnapshotIntoLiveExceptMoney(snapshot) {
    SYNC_KEYS.forEach((k) => { if (!MONEY_LOCAL_KEYS.has(k)) localStorage.removeItem(k); });
    Object.entries(snapshot || {}).forEach(([k, v]) => {
      if (!MONEY_LOCAL_KEYS.has(k)) localStorage.setItem(k, v);
    });
  }

  // Saves the CURRENTLY active account's live state back into its registry entry, so nothing
  // played this session is lost. No-op if no account is currently active on this browser.
  const ACTIVE_ACCOUNT_KEY = "nj_active_account"; // which username in the registry this browser is currently playing as (not itself synced/exported)
  function getActiveAccountUsername() {
    return localStorage.getItem(ACTIVE_ACCOUNT_KEY) || "";
  }
  function persistActiveAccount() {
    const username = getActiveAccountUsername();
    if (!username) return;
    const accts = getAccounts();
    if (!accts[username]) return;
    accts[username].snapshot = snapshotCurrentState();
    accts[username].savedAt = Date.now();
    setAccounts(accts);
  }
  // ---------- live full-account sync ----------
  // Instead of syncing individual numbers (balance, vault, cases, passive income...) one at a
  // time, this pushes the ENTIRE local save snapshot to Firebase every time anything changes,
  // and every open device listens for changes and pulls the whole thing down live. This is what
  // stops two devices both acting on the same stale copy (e.g. both claiming the same passive
  // income, or one device's vault withdrawal getting silently reverted by the other).
  // ---------------------------------------------------------------------
  // LIVE SYNC v2 — every device writes numeric/critical fields directly to
  // their OWN small Firebase path using transaction() (read-current, write-
  // computed-delta, auto-retry on conflict). This makes concurrent writes
  // from two devices commutative instead of "last write wins" — no more
  // balance getting silently rolled back by a stale device.
  //
  // Every device also keeps a live .on("value") listener on each of these
  // paths, so any change from any device shows up everywhere within
  // milliseconds — no refresh needed.
  //
  // Fields synced this way: cash balance, vault balance, reward balance,
  // lifetime wagered, rakeback available/claimed, raffle claimedSteps
  // (wager cases), and the bet log (appended, not overwritten).
  //
  // Everything else (player profile, settings, favorites, earn/incremental
  // state, notifications, etc.) still uses the old whole-snapshot push —
  // those are fine to eventually-consistent since they're not money and
  // don't get raced the same way, and rewriting ALL of it into per-field
  // transactions would be a much bigger change for little benefit.
  // ---------------------------------------------------------------------
  let liveAccountUnsub = null;
  let liveAccountRetryTimer = null;
  let applyingRemoteAccountUpdate = false; // guards against re-pushing what we just received
  let pushLiveAccountTimer = null;
  let lastForcedPushAt = 0;

  // Fields this device writes via transaction() rather than the whole-blob push.
  const LIVE_FIELD_MAP = {
    cash:            { get: getCashBalance,           localKey: BALANCE_KEY },
    vault:           { get: getVaultBalance,           localKey: VAULT_KEY },
    reward:          { get: getRewardBalance,          localKey: REWARD_BALANCE_KEY },
    lifetimeWagered: { get: getLifetimeWagered,         localKey: LIFETIME_WAGERED_KEY },
    legendaryCases:  { get: getLegendaryCasesOwned,     localKey: LEGENDARY_CASE_OWNED_KEY },
    exoticCases:     { get: getExoticCasesOwned,        localKey: EXOTIC_CASE_OWNED_KEY },
  };

  const MONEY_LOCAL_KEYS = new Set(Object.values(LIVE_FIELD_MAP).map((f) => f.localKey));

  function liveFieldRef(username, field) {
    const db = getCloudDb();
    if (!db || !username) return null;
    return db.ref("liveFields/" + username + "/" + field);
  }

  // Writes the field's CURRENT local value into Firebase via transaction — this doesn't
  // "add" anything by itself, it's used right after a local mutation (setCashBalance, etc.)
  // has already computed the new value. The transaction just makes sure that if another
  // device's write is still in flight, ours doesn't blindly clobber it — Firebase reruns
  // our update function against whatever the latest server value actually is.
  function pushLiveField(field) {
    if (applyingRemoteAccountUpdate) return;
    const username = getActiveAccountUsername();
    if (!username) return;
    const ref = liveFieldRef(username, field);
    if (!ref) return;
    const def = LIVE_FIELD_MAP[field];
    if (!def) return;
    const localValue = def.get();
    ref.transaction((serverValue) => {
      // If nothing has ever been written, or the server's copy is stale compared to what
      // we just computed locally, take our local value. This transaction's job is mainly
      // to avoid a lost-update race — for these fields the "latest local mutation wins"
      // is correct because addCashBalance/addVaultBalance/etc. already read-then-wrote
      // against localStorage synchronously right before this runs.
      return localValue;
    }).catch(() => {});
  }

  // Call this right after any local mutation to one of the LIVE_FIELD_MAP fields.
  function syncLiveField(field) {
    clearTimeout(pushLiveAccountTimer);
    pushLiveField(field);
  }

  function startLiveFieldListeners(username) {
    Object.keys(LIVE_FIELD_MAP).forEach((field) => {
      const ref = liveFieldRef(username, field);
      if (!ref) return;
      ref.on("value", (snap) => {
        const val = snap.val();
        if (val === null || val === undefined) return;
        const def = LIVE_FIELD_MAP[field];
        const current = localStorage.getItem(def.localKey);
        const currentNum = current === null ? null : parseFloat(current);
        if (currentNum === val) return; // already up to date, avoid redundant event spam
        applyingRemoteAccountUpdate = true;
        localStorage.setItem(def.localKey, String(val));
        applyingRemoteAccountUpdate = false;
        if (field === "cash") document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
        if (field === "vault") document.dispatchEvent(new CustomEvent("nj:vault", { detail: getVaultBalance() }));
        if (field === "reward") { document.dispatchEvent(new CustomEvent("nj:reward", { detail: getRewardBalance() })); document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() })); }
        if (field === "lifetimeWagered") document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
        if (field === "legendaryCases") document.dispatchEvent(new CustomEvent("nj:legendarycases", { detail: getLegendaryCasesOwned() }));
        if (field === "exoticCases") document.dispatchEvent(new CustomEvent("nj:exoticcases", { detail: getExoticCasesOwned() }));
      });
    });
  }

  // ---- bet log: appended live via push(), not overwritten ----
  // Each new bet gets its own child key under liveBets/{username}/{pushId}, so two devices
  // adding bets at the same instant can never stomp each other — Firebase just ends up with
  // both children. Every device listens for new children and merges them into its local log.
  let liveBetsSeenIds = new Set();
  function pushLiveBet(entry) {
    const username = getActiveAccountUsername();
    const db = getCloudDb();
    if (!username || !db) return;
    db.ref("liveBets/" + username).push({ ...entry }).catch(() => {});
  }
  function startLiveBetListener(username) {
    const db = getCloudDb();
    if (!db) return;
    const ref = db.ref("liveBets/" + username).limitToLast(20);
    ref.on("child_added", (snap) => {
      const id = snap.key;
      if (liveBetsSeenIds.has(id)) return;
      liveBetsSeenIds.add(id);
      const entry = snap.val();
      if (!entry) return;
      // Only merge in bets we don't already have locally (matched by time+bet+game — good
      // enough for this demo's purposes) so our OWN just-placed bet doesn't get double-added
      // when Firebase echoes it back to us.
      const list = getBetLog();
      const dup = list.some((b) => b.time === entry.time && b.game === entry.game && b.bet === entry.bet && b.profit === entry.profit);
      if (dup) return;
      list.push(entry);
      list.sort((a, b) => a.time - b.time);
      if (list.length > 2000) list.splice(0, list.length - 2000);
      localStorage.setItem(BETLOG_KEY, JSON.stringify(list));
      document.dispatchEvent(new CustomEvent("nj:betlog", { detail: list }));
    });
  }

  // ---- raffle/wager-case claimedSteps: synced via transaction too, since opening a case
  // on one device while another device's stale count is still loaded must never let the
  // case be "un-claimed" or double-claimed. ----
  function pushLiveRaffleState() {
    const username = getActiveAccountUsername();
    if (!username) return;
    const ref = liveFieldRef(username, "raffleClaimedSteps");
    if (!ref) return;
    const local = getRaffleState().claimedSteps || 0;
    ref.transaction(() => local).catch(() => {});
  }
  function startLiveRaffleListener(username) {
    const ref = liveFieldRef(username, "raffleClaimedSteps");
    if (!ref) return;
    ref.on("value", (snap) => {
      const val = snap.val();
      if (val === null || val === undefined) return;
      const s = getRaffleState();
      if ((s.claimedSteps || 0) === val) return;
      applyingRemoteAccountUpdate = true;
      s.claimedSteps = val;
      localStorage.setItem(RAFFLE_KEY, JSON.stringify(s));
      applyingRemoteAccountUpdate = false;
      document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
    });
  }

  // ---------------------------------------------------------------------
  // Guards against a stale tab overwriting newer data. Bumped every time
  // we successfully pull or push, so a push can only succeed if it's not
  // older than the last known state.
  // ---------------------------------------------------------------------
  let liveAccountGen = 0;
  let liveAccountPullInFlight = false;

  function pushLiveAccountStateNow() {
    if (applyingRemoteAccountUpdate) return;
    if (liveAccountPullInFlight) return;
    const username = getActiveAccountUsername();
    const db = getCloudDb();
    if (!username || !db) return;
    const snapshot = snapshotCurrentState();
    const myGen = Date.now();
    const ref = db.ref("liveAccounts/" + username);
    ref.transaction((current) => {
      if (current && current.savedAt && current.savedAt > liveAccountGen) {
        return; // abort — server has something newer than what we're aware of
      }
      return { snapshot, savedAt: myGen };
    }).then((result) => {
      if (result.committed) liveAccountGen = myGen;
    }).catch(() => {});
  }

  function pushLiveAccountState() {
    if (applyingRemoteAccountUpdate) return;
    if (liveAccountPullInFlight) return;
    clearTimeout(pushLiveAccountTimer);
    pushLiveAccountTimer = setTimeout(pushLiveAccountStateNow, 120);
  }

  function startLiveAccountSync() {
    if (liveAccountUnsub) return;
    const username = getActiveAccountUsername();
    const db = getCloudDb();
    if (!username || !db) {
      clearTimeout(liveAccountRetryTimer);
      liveAccountRetryTimer = setTimeout(startLiveAccountSync, 1000);
      return;
    }
    const ref = db.ref("liveAccounts/" + username);
    let lastAppliedSavedAt = 0;
    const handler = (snap) => {
      const val = snap.val();
      if (!val || !val.snapshot) return;
      if ((val.savedAt || 0) <= lastAppliedSavedAt) return;
      lastAppliedSavedAt = val.savedAt || 0;
      liveAccountGen = Math.max(liveAccountGen, val.savedAt || 0); // ADD THIS LINE
      applyingRemoteAccountUpdate = true;
      // IMPORTANT: only load the non-money keys from this whole-snapshot blob now — the
      // money/critical fields (cash, vault, reward, lifetimeWagered) are owned by the
      // per-field transaction listeners above and must NOT be clobbered by this older,
      // coarser sync path.
      const skip = new Set([BALANCE_KEY, VAULT_KEY, REWARD_BALANCE_KEY, LIFETIME_WAGERED_KEY, MONEY_LOCAL_KEYS, BETLOG_KEY, RAFFLE_KEY]);
      Object.entries(val.snapshot).forEach(([k, v]) => {
        if (skip.has(k)) return;
        localStorage.setItem(k, v);
      });
      applyingRemoteAccountUpdate = false;
      document.dispatchEvent(new CustomEvent("nj:reward", { detail: getRewardBalance() }));
      document.dispatchEvent(new CustomEvent("nj:earn", { detail: getEarnState() }));
    };
    ref.on("value", handler);
    liveAccountUnsub = () => ref.off("value", handler);
    startLiveFieldListeners(username);
    startLiveBetListener(username);
    startLiveRaffleListener(username);
    pushLiveAccountState(); // seed non-money fields on first connect (safely gated by liveAccountGen)
    // Money fields (cash/vault/reward/lifetimeWagered) and the raffle case count are
    // intentionally NOT force-pushed here anymore. Blindly pushing the local value on every
    // fresh page load raced against the real-time listeners started just above
    // (startLiveFieldListeners / startLiveRaffleListener) and could overwrite a NEWER value
    // already on the server with a STALE local one — exactly what happened when reopening the
    // app on a device that had been closed since before a balance change made elsewhere.
    // The listeners already pull down the correct current value on their own; nothing needs
    // to be manually "seeded" except when the player actually performs a real balance-changing
    // action locally, which already calls syncLiveField() via addCashBalance/addVaultBalance/etc.
  }

  // ---------- register a brand-new account (used by the post-logout Register screen) ----------
  // Wipes every synced key plus the player identity, creates a fresh player, and stores that
  // fresh state as a new entry in the account registry under the chosen username/password.
  function registerAccount({ username, password, name, avatarColor, avatarEmoji, seedSnapshot }) {
    const uname = (username || "").trim();
    if (!uname || !password) return { ok: false, error: "Enter a username and password." };
    const accts = getAccounts();
    // Case-insensitive collision check — "Bob" and "bob" must not both be allowed to register,
    // since it would silently let two different people BOTH claim what looks like the same name.
    const unameLower = uname.toLowerCase();
    const taken = Object.keys(accts).some((existing) => existing.toLowerCase() === unameLower);
    if (taken) return { ok: false, error: "That username is already taken." };

    if (seedSnapshot) {
      // Migrating an old sync code into a new account: keep the imported progress as-is.
      loadSnapshotIntoLive(seedSnapshot);
    } else {
      // Brand-new player: wipe and start fresh, same as the old registerNewAccount did.
      SYNC_KEYS.forEach((k) => localStorage.removeItem(k));
      const p = {
        id: genPlayerId(),
        name: uname, // display name is always exactly the username — no separate "display name" to mix up
        memberSince: Date.now(),
        avatarColor: avatarColor || "#5cffe7",
        avatarEmoji: (avatarEmoji || "").trim(),
      };
      localStorage.setItem(PLAYER_KEY, JSON.stringify(p));
    }

    const acct = { password, snapshot: snapshotCurrentState(), syncCodeClaimed: !!seedSnapshot };
    accts[uname] = acct;
    setAccounts(accts);
    cloudSaveAccount(uname, acct); // NEW — also save to Firebase so other devices can log in
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, uname);
    loginBackIn();
    return { ok: true };
  }

  // Used only by the login gate's "Quick switch" buttons — logs straight into an account that's
  // already in THIS browser's own registry, without re-prompting for its password. This isn't a
  // security bypass: the password is already sitting in this browser's localStorage either way,
  // so re-typing it here wouldn't protect anything a person with access to the browser doesn't
  // already have — it would just be friction. A brand-new device/browser has no registry entries
  // to quick-switch to and still has to go through the normal username+password Log In form.
  function switchToKnownAccount(username) {
    const uname = (username || "").trim();
    const accts = getAccounts();
    const acct = accts[uname];
    if (!acct) return false;
    loadSnapshotIntoLive(acct.snapshot);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, uname);
    loginBackIn();
    return true;
  }

  // ---------- log into an existing account (used by the post-logout Log In screen) ----------
  // Now async: checks this browser's local copy first (instant), and if not found there,
  // asks Firebase (works from a brand-new device/PC that's never seen this account before).
  async function loginToAccount(username, password) {
    const uname = (username || "").trim();
    const accts = getAccounts();
    // Case-insensitive lookup — find the stored key that matches regardless of case.
    const matchKey = Object.keys(accts).find((k) => k.toLowerCase() === uname.toLowerCase());
    let acct = matchKey ? accts[matchKey] : undefined;

    if (!acct) {
      // Not on this device yet — try fetching it from the cloud.
      acct = await cloudFetchAccount(uname);
      if (acct) {
        // Cache it locally too, so next time this device doesn't need the network.
        accts[uname] = acct;
        setAccounts(accts);
      }
    }

    if (!acct || acct.password !== password) return false;
    loadSnapshotIntoLive(acct.snapshot);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, uname);
    loginBackIn();
    return true;
  }

  // ---------- remove a saved account from this browser's registry ----------
  // Used only by the "x" on the login gate's "Quick switch" list. Refuses to remove the
  // currently active account (that path is Log Out / a real account deletion, not this). This
  // only forgets the account on THIS browser — the account itself isn't "deleted" anywhere else;
  // if it's ever needed again, logging in with its username/password just won't work here
  // anymore unless it's re-created via the normal Register/sync-code-migration flow.
  function removeSavedAccount(username) {
    const uname = (username || "").trim();
    if (!uname) return false;
    if (uname === getActiveAccountUsername()) return false; // can't remove the account you're currently on from here
    const accts = getAccounts();
    if (!accts[uname]) return false;
    delete accts[uname];
    setAccounts(accts);
    return true;
  }

  // ---------- change password for the currently active account ----------
  // Requires the correct current password before allowing a change, same trust model as any
  // password-change form — knowing the old password is what proves it's really the owner.
  function changePassword(currentPassword, newPassword) {
    const uname = getActiveAccountUsername();
    if (!uname) return { ok: false, error: "No account is currently active." };
    if (!newPassword) return { ok: false, error: "Enter a new password." };
    const accts = getAccounts();
    const acct = accts[uname];
    if (!acct || acct.password !== currentPassword) return { ok: false, error: "Current password is incorrect." };
    acct.password = newPassword;
    setAccounts(accts);
    return { ok: true };
  }

  function changeUsername(newUsername, password) {
    const clean = (newUsername || "").trim();
    if (!clean) return { ok: false, error: "Enter a new username." };
    const currentUsername = getActiveAccountUsername();
    if (!currentUsername) return { ok: false, error: "No account is currently active." };
    const accts = getAccounts();
    const acct = accts[currentUsername];
    if (!acct || acct.password !== password) return { ok: false, error: "Incorrect password." };

    // If they didn't actually change anything, treat it as a no-op success.
    if (clean.toLowerCase() === currentUsername.toLowerCase()) return { ok: true };

    // Case-insensitive collision check, same rule as registerAccount.
    const cleanLower = clean.toLowerCase();
    const taken = Object.keys(accts).some((u) => u.toLowerCase() === cleanLower);
    if (taken) return { ok: false, error: "That username is already taken." };

    delete accts[currentUsername];
    accts[clean] = acct;
    setAccounts(accts);
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, clean);
    setPlayerProfile({ name: clean });
    persistActiveAccount();
    cloudSaveAccount(clean, acct);
    return { ok: true };
  }

  // ---------- switch accounts ----------
  // Persists whatever's currently live back into the active account's registry entry (so nothing
  // is lost), then opens the login gate so the player can log into a different existing account
  // or register a brand-new one. Unlike a full Logout, this doesn't require a page reload first —
  // the login gate itself handles wiping the live keys once the player actually picks an account.
  function switchAccount() {
    persistActiveAccount();
    renderLoginGate({ switching: true });
  }
  function hasOtherAccounts() {
    const accts = getAccounts();
    const current = getActiveAccountUsername();
    return Object.keys(accts).some((u) => u !== current);
  }

  // ---------- legacy sync code path ----------
  // A player who only ever had a sync code (from before accounts existed) pastes it at the
  // login screen. This does NOT log them in directly — it decodes the code and hands the data
  // back so the UI can open "Create account", where the player picks a username/password to
  // attach that progress to going forward. One sync code can only ever be turned into one
  // account (nothing stops the same code being staged twice, but each attempt requires
  // picking a still-available username, same as any other registration).
  function decodeSyncCodeForMigration(code) {
    if (!code || !code.trim()) return null;
    try {
      const json = decodeURIComponent(escape(atob(code.trim())));
      const parsed = JSON.parse(json);
      if (!parsed || !parsed.data) return null;
      return parsed.data;
    } catch { return null; }
  }

  // ---------- daily / weekly / pre-monthly / monthly claimable bonuses ----------
  function getClaimState() {
    try { return JSON.parse(localStorage.getItem(CLAIM_KEY)) || {}; } catch { return {}; }
  }
  function setClaimState(s) { localStorage.setItem(CLAIM_KEY, JSON.stringify(s)); }
  function claimRemaining(key) {
    const s = getClaimState();
    const now = Date.now();
    return s[key] && s[key] > now ? s[key] - now : 0;
  }
  function claimReward(key) {
    if (claimRemaining(key) > 0) return false;
    const s = getClaimState();
    const now = Date.now();
    const amount = REWARD_AMOUNTS[key] || 0;
    addBalance(amount);
    s[key] = now + (REWARD_COOLDOWNS[key] || 86400000);
    setClaimState(s);
    const totals = getClaimTotals();
    totals[key] = (totals[key] || 0) + amount;
    localStorage.setItem(CLAIM_TOTALS_KEY, JSON.stringify(totals));
    persistActiveAccount();
    pushLiveAccountStateNow();
    return amount;
  }
  function getClaimTotals() {
    try { return JSON.parse(localStorage.getItem(CLAIM_TOTALS_KEY)) || {}; } catch { return {}; }
  }

  // ---------- rakeback: accrues a small % of every wager, claimable any time it's > 0 ----------
  function getRakebackState() {
    try { return JSON.parse(localStorage.getItem(RAKEBACK_KEY)) || { available: 0, claimedTotal: 0 }; }
    catch { return { available: 0, claimedTotal: 0 }; }
  }
  function setRakebackState(s) { localStorage.setItem(RAKEBACK_KEY, JSON.stringify(s)); }
  function accrueRakeback(betAmount) {
    if (!betAmount || betAmount <= 0) return;
    const s = getRakebackState();
    s.available = (s.available || 0) + betAmount * RAKEBACK_RATE * (1 + activeBoostPct("rakeback"));
    setRakebackState(s);
  }
  function getRakebackAvailable() {
    return getRakebackState().available || 0;
  }
  function claimRakeback() {
    const s = getRakebackState();
    const amount = Math.round((s.available || 0) * 100) / 100;
    if (amount <= 0) return 0;
    addBalance(amount);
    s.available = 0;
    s.claimedTotal = (s.claimedTotal || 0) + amount;
    setRakebackState(s);
    const totals = getClaimTotals();
    totals.rakeback = (totals.rakeback || 0) + amount;
    localStorage.setItem(CLAIM_TOTALS_KEY, JSON.stringify(totals));
    persistActiveAccount();
    pushLiveAccountStateNow();
    return amount;
  }
  function fmtCountdown(ms) {
    const totalMin = Math.max(1, Math.ceil(ms / 60000));
    const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
    if (d > 0) return `${d}d`;
    if (h > 0) return `${h}h`;
    return `${m}m`;
  }
  function fmtClock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = String(Math.floor(s / 3600)).padStart(2, "0");
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
    const sec = String(s % 60).padStart(2, "0");
    return `${h}:${m}:${sec}`;
  }
  function getBoostRemaining() {
    let end = parseInt(localStorage.getItem(BOOST_KEY) || "0", 10);
    const now = Date.now();
    if (!end || end < now) { end = now + 55 * 60000; localStorage.setItem(BOOST_KEY, String(end)); }
    return end - now;
  }

  // ---------- developer mode ----------
  // A hidden unlock, entered via a secret code in the Profile modal. Once unlocked, the
  // player gets a "Developer" section there with tools to edit balance, force any rank,
  // max the incremental game, grant wager cases, and — uniquely to developers — create
  // claimable promo codes. This is a client-side demo feature (everything lives in
  // localStorage), not a real auth/admin system.
  const DEV_SECRET = "NEONROOT"; // the "secret code" the player types into the profile modal
  // Developer unlock is per-account: it's part of SYNC_KEYS, so it travels with an exported/
  // imported account and is wiped on a fresh registerAccount() like everything else. It is NOT
  // site-wide — logging out and creating a fresh account starts locked again.
  function isDeveloperUnlocked() {
    return localStorage.getItem(DEV_KEY) === "1";
  }
  function isDeveloperEnabled() {
    const raw = localStorage.getItem(DEV_ENABLED_KEY);
    return raw === null ? true : raw === "1"; // default on once unlocked, unless explicitly turned off
  }
  function isAppearOffline() {
    return localStorage.getItem(APPEAR_OFFLINE_KEY) === "1";
  }
  function setAppearOffline(value) {
    if (value) localStorage.setItem(APPEAR_OFFLINE_KEY, "1");
    else localStorage.removeItem(APPEAR_OFFLINE_KEY);
    document.dispatchEvent(new CustomEvent("nj:appearoffline", { detail: !!value }));
    return !!value;
  }
  function setDeveloperEnabled(value) {
    localStorage.setItem(DEV_ENABLED_KEY, value ? "1" : "0");
    document.dispatchEvent(new CustomEvent("nj:developer", { detail: isDeveloper() }));
    return !!value;
  }
  function isDeveloper() {
    return isDeveloperUnlocked() && isDeveloperEnabled();
  }
  function tryUnlockDeveloper(code) {
    if ((code || "").trim().toUpperCase() === DEV_SECRET) {
      localStorage.setItem(DEV_KEY, "1");
      localStorage.setItem(DEV_ENABLED_KEY, "1");
      document.dispatchEvent(new CustomEvent("nj:developer", { detail: isDeveloper() }));
      return true;
    }
    return false;
  }
  function devSetBalance(amount) {
    if (!isDeveloper()) return false;
    devSnapshotIfNeeded();
    setCashBalance(Math.max(0, amount || 0));
    return true;
  }
  function devSetRank(tier) {
    if (!isDeveloper()) return false;
    devSnapshotIfNeeded();
    const t = Math.max(0, Math.min(RANK_TOTAL_TIERS, tier || 0));
    localStorage.setItem(LIFETIME_WAGERED_KEY, String(rankTierThreshold(t)));
    document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
    return true;
  }
  function devMaxRank() {
    return devSetRank(RANK_TOTAL_TIERS);
  }
  function devMaxIncremental() {
    if (!isDeveloper()) return false;
    devSnapshotIfNeeded();
    const state = getEarnState();
    EARN_UPGRADES.forEach((u) => { state.levels[u.id] = u.maxLevel || 999; });
    setEarnState(state);
    return true;
  }
  function devResetIncremental() {
    if (!isDeveloper()) return false;
    devSnapshotIfNeeded();
    const state = getEarnState();
    EARN_UPGRADES.forEach((u) => { state.levels[u.id] = 0; });
    setEarnState(state);
    return true;
  }
  function devResetCaseUpgrades() {
    if (!isDeveloper()) return false;
    devSnapshotIfNeeded();
    setCaseUpgrades({ luck: 0, speed: 0 });
    return true;
  }
  function devGrantCases(count) {
    if (!isDeveloper()) return false;
    devSnapshotIfNeeded();
    const n = Math.max(0, Math.floor(count || 0));
    const s = getRaffleState();
    s.claimedSteps = Math.max(0, (s.claimedSteps || 0) - n);
    setRaffleState(s);
    return true;
  }

  // ---------- developer "revert changes" snapshot ----------
  // The very first time any dev tool is used in a session, the account's current state (the
  // same set of keys resetAllProgress touches) is snapshotted once. "Revert changes" restores
  // that snapshot exactly, undoing every dev edit made since — but only ever the FIRST snapshot
  // taken, so reverting always returns to how things were right before you started tinkering,
  // not to some more recent halfway point.
  const DEV_SNAPSHOT_KEYS = [
    BALANCE_KEY, VAULT_KEY, BETLOG_KEY, EARN_KEY, CLAIM_KEY, CLAIM_TOTALS_KEY,
    RAFFLE_KEY, LIFETIME_WAGERED_KEY, RAKEBACK_KEY,
    REWARD_BALANCE_KEY, ACTIVE_CURRENCY_KEY, REWARD_LOCK_KEY, CASE_UPGRADE_KEY,
  ];
  // The snapshot must only ever represent "how things were right before this browser
  // SESSION's dev-tool changes" — never something left over from a previous session that
  // was never explicitly reverted. Without this, a snapshot taken once (even accidentally,
  // long ago) would sit in localStorage forever, and every future "Revert changes" click
  // would silently roll back to that ancient state instead of the current session's actual
  // starting point — e.g. wiping out rank/wager progress earned entirely through normal
  // play in between. DEV_SNAPSHOT_SESSION_KEY lives in sessionStorage (tab-only, cleared
  // when the browser/tab closes) and marks "this snapshot was taken during the CURRENT
  // session." On every mount(), any snapshot missing that current-session marker is treated
  // as stale and discarded, so the next dev-tool action captures a fresh, correct baseline.
  const DEV_SNAPSHOT_SESSION_KEY = "nj_dev_snapshot_session";
  function hasDevSnapshot() {
    return localStorage.getItem(DEV_SNAPSHOT_KEY) !== null;
  }
  function clearStaleDevSnapshot() {
    if (localStorage.getItem(DEV_SNAPSHOT_KEY) !== null && sessionStorage.getItem(DEV_SNAPSHOT_SESSION_KEY) !== "1") {
      localStorage.removeItem(DEV_SNAPSHOT_KEY);
    }
  }
  function devSnapshotIfNeeded() {
    if (hasDevSnapshot()) return;
    const snap = {};
    DEV_SNAPSHOT_KEYS.forEach((k) => { snap[k] = localStorage.getItem(k); });
    localStorage.setItem(DEV_SNAPSHOT_KEY, JSON.stringify(snap));
    sessionStorage.setItem(DEV_SNAPSHOT_SESSION_KEY, "1");
  }
  function devRevertChanges() {
    if (!isDeveloper()) return false;
    const raw = localStorage.getItem(DEV_SNAPSHOT_KEY);
    if (raw === null) return false;
    let snap;
    try { snap = JSON.parse(raw); } catch { return false; }
    DEV_SNAPSHOT_KEYS.forEach((k) => {
      const v = snap[k];
      if (v === null || v === undefined) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    });
    localStorage.removeItem(DEV_SNAPSHOT_KEY);
    sessionStorage.removeItem(DEV_SNAPSHOT_SESSION_KEY);
    document.dispatchEvent(new CustomEvent("nj:balance", { detail: getBalance() }));
    document.dispatchEvent(new CustomEvent("nj:vault", { detail: getVaultBalance() }));
    document.dispatchEvent(new CustomEvent("nj:betlog", { detail: getBetLog() }));
    document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
    document.dispatchEvent(new CustomEvent("nj:reward", { detail: getRewardBalance() }));
    document.dispatchEvent(new CustomEvent("nj:rewardlock", { detail: getRewardLockState() }));
    document.dispatchEvent(new CustomEvent("nj:currency", { detail: getActiveCurrency() }));
    document.dispatchEvent(new CustomEvent("nj:caseupgrades", { detail: getCaseUpgrades() }));
    return true;
  }

  // ---------- promo / claim codes (fixed, pre-generated set — sealed in ./promo-vault.js) ----------
  // The 100 real codes ship in a separate file (promo-vault.js) as a base64 blob so they aren't
  // sitting in plain readable text in this file. Each code is single-use per BROWSER/DEVICE, not
  // per-account — redemption history lives in PROMO_REDEEMED_KEY, which is deliberately excluded
  // from SYNC_KEYS/account snapshots so it's shared by every account ever logged into on this
  // browser. This is what stops the "claim a code, switch to a fresh account, claim it again"
  // exploit — the ledger doesn't reset or fork when you switch accounts. Because this is a static
  // site with no shared server, that's still only enforced per-device: a code can be redeemed once
  // per browser, but a different browser/device has its own independent redemption history.
  let __njPromoVaultCache = null;
  function getPromoVault() {
    if (__njPromoVaultCache) return __njPromoVaultCache;
    try {
      const raw = window.__njPromoVault;
      if (!raw) return (__njPromoVaultCache = []);
      const decoded = JSON.parse(atob(raw));
      return (__njPromoVaultCache = Array.isArray(decoded) ? decoded : []);
    } catch { return (__njPromoVaultCache = []); }
  }
  function getRedeemedCodes() {
    try { return JSON.parse(localStorage.getItem(PROMO_REDEEMED_KEY)) || {}; } catch { return {}; }
  }
  function setRedeemedCodes(obj) { localStorage.setItem(PROMO_REDEEMED_KEY, JSON.stringify(obj)); }

  // Returns { ok:true, cash, cases } on success, or { ok:false, reason } on failure.
  // reason is one of: "invalid" (code doesn't exist) or "redeemed" (already claimed on this device).
  function redeemPromoCode(code) {
    const clean = (code || "").trim().toUpperCase();
    if (!clean) return { ok: false, reason: "invalid" };
    const entry = getPromoVault().find((e) => e.code === clean);
    if (!entry) return { ok: false, reason: "invalid" };
    const redeemed = getRedeemedCodes();
    if (redeemed[clean]) return { ok: false, reason: "redeemed" };
    redeemed[clean] = 1;
    setRedeemedCodes(redeemed);
    if (entry.cash) {
      // Claim codes pay out in reward balance, not cash — it can only be spent on games/slots,
      // and must be wagered through before any of it can be converted to real cash (see the
      // reward-lock section above / the Exchange Currency modal).
      const balanceBeforeClaim = getRewardBalance();
      addRewardBalance(entry.cash);
      addRewardClaimed(entry.cash, balanceBeforeClaim);
    }
    if (entry.cases) devGrantCasesToSelf(entry.cases);
    return { ok: true, cash: entry.cash || 0, cases: entry.cases || 0 };
  }
  // Grants wager cases to whoever redeems — doesn't require developer status.
  function devGrantCasesToSelf(count) {
    const n = Math.max(0, Math.floor(count || 0));
    const s = getRaffleState();
    s.claimedSteps = Math.max(0, (s.claimedSteps || 0) - n);
    setRaffleState(s);
  }


  // ---------- rank system ----------
  // Unranked -> Bronze -> Silver -> Gold -> Platinum -> Diamond -> Infernal -> Infernal Diamond,
  // each rank (besides Unranked) has 4 tiers (I-IV). Progress is driven by lifetime $ wagered
  // (pulled straight from the shared bet log), and every threshold scales off the max-rank
  // requirement below so the whole curve adjusts automatically if that number ever changes.
  const RANK_TRACKS = ["Bronze", "Silver", "Gold", "Platinum", "Diamond", "Infernal", "Infernal Diamond"];
  const RANK_TIERS = 4;
  const RANK_TOTAL_TIERS = RANK_TRACKS.length * RANK_TIERS; // 28
  const RANK_MAX_WAGER = 1000000000; // wagered required to hit the very top tier (Infernal Diamond IV)
  const RANK_BASE_WAGER = 100; // wagered required for the very first tier (Bronze I)
  const RANK_GROWTH = Math.pow(RANK_MAX_WAGER / RANK_BASE_WAGER, 1 / (RANK_TOTAL_TIERS - 1));

  function rankTierThreshold(tier) {
    if (tier <= 0) return 0;
    if (tier >= RANK_TOTAL_TIERS) return RANK_MAX_WAGER;
    return RANK_BASE_WAGER * Math.pow(RANK_GROWTH, tier - 1);
  }
  function rankTierTrack(tier) {
    if (tier <= 0) return "Unranked";
    return RANK_TRACKS[Math.floor((tier - 1) / RANK_TIERS)];
  }
  function rankTierRoman(tier) {
    if (tier <= 0) return "";
    return ["I", "II", "III", "IV"][(tier - 1) % RANK_TIERS];
  }
  function rankTierLabel(tier) {
    if (tier <= 0) return "Unranked";
    return `${rankTierTrack(tier)} ${rankTierRoman(tier)}`;
  }
  function rankStats() {
    const log = getBetLog();
    const totalWagered = getLifetimeWagered();
    const totalBets = log.length;
    let tier = 0;
    for (let i = 1; i <= RANK_TOTAL_TIERS; i++) { if (totalWagered >= rankTierThreshold(i)) tier = i; else break; }
    const isMax = tier >= RANK_TOTAL_TIERS;
    const floor = rankTierThreshold(tier);
    const ceil = isMax ? floor : rankTierThreshold(tier + 1);
    const pct = isMax ? 100 : Math.max(0, Math.min(100, ((totalWagered - floor) / (ceil - floor)) * 100));
    return {
      totalWagered, totalBets, tier, isMax,
      label: rankTierLabel(tier),
      track: rankTierTrack(tier),
      nextLabel: isMax ? rankTierLabel(tier) : rankTierLabel(tier + 1),
      floor, ceil, pct,
    };
  }

  // ---------- rank color coding (text color + glow per track, used anywhere a rank label appears) ----------
  const RANK_COLORS = {
    "Unranked":        { color: "#8791a6", glow: "rgba(135,145,166,.35)" },
    "Bronze":          { color: "#cd8a4d", glow: "rgba(205,138,77,.55)" },
    "Silver":          { color: "#e6ebf5", glow: "rgba(255,255,255,.55)" },
    "Gold":            { color: "#f4c979", glow: "rgba(244,201,121,.55)" },
    "Platinum":        { color: "#8fe0d8", glow: "rgba(143,224,216,.55)" },
    "Diamond":         { color: "#3aa7ff", glow: "rgba(58,167,255,.65)" },
    "Infernal":        { color: "#ff5c7a", glow: "rgba(255,92,122,.6)" },
    "Infernal Diamond":{ color: "#c98bff", glow: "rgba(201,139,255,.65)" },
  };
  function rankColorFor(track) {
    return RANK_COLORS[track] || RANK_COLORS["Unranked"];
  }
  // Returns an inline style string that colors + glows rank text according to its track.
  function rankTextStyle(track) {
    const c = rankColorFor(track);
    return `color:${c.color};text-shadow:0 0 10px ${c.glow}, 0 0 2px ${c.glow};`;
  }

  // ---------- wager case (replaces the old "Midnight Pass") ----------
  // Every $500 wagered (lifetime) earns one free case opening. Rewards scale with rank: higher
  // ranks get a better shot at Major/Grand and bigger dollar values across the board.
  //
  // Bug fix: earnedSteps is now recomputed fresh from getLifetimeWagered() (the single source of
  // truth every bet increments) on every call, and claimedSteps is clamped so it can never exceed
  // earnedSteps. This guarantees a case is granted the instant the running total crosses each
  // $500 multiple, instead of occasionally coming back 0 right at the threshold.
  const RAFFLE_WAGER_STEP = 500;
  const RAFFLE_TIERS = [
    { key: "none",  label: "Better luck next time", color: "#6d7891" },
    { key: "mini",  label: "Mini",  color: "#8fe0d8" },
    { key: "minor", label: "Minor", color: "#3aa0ff" },
    { key: "major", label: "Major", color: "#ff5c9f" },
    { key: "grand", label: "Grand", color: "#ffcf7d" },
  ];
  // Legendary is a distinct, guaranteed-win tier that never appears in the normal weighted
  // wheel (raffleOddsForRank never rolls it). It's only ever awarded by combineCasesForLegendary,
  // which burns LEGENDARY_CASE_COST regular case openings for one Legendary opening.
  const LEGENDARY_TIER = { key: "legendary", label: "Legendary", color: "#ff8a3d" };
  const EXOTIC_TIER = { key: "exotic", label: "Exotic", color: "#ff3df0" };
  const LEGENDARY_CASE_COST = 25; // regular cases needed to convert into 1 Legendary case
  const EXOTIC_CASE_COST = 25;    // Legendary cases needed to convert into 1 Exotic case

  // ---------- owned Legendary / Exotic case counts (converted, not yet opened) ----------
  function getLegendaryCasesOwned() {
    const n = parseInt(localStorage.getItem(LEGENDARY_CASE_OWNED_KEY), 10);
    return isNaN(n) ? 0 : n;
  }
  function setLegendaryCasesOwned(n) {
    localStorage.setItem(LEGENDARY_CASE_OWNED_KEY, String(Math.max(0, n)));
    document.dispatchEvent(new CustomEvent("nj:legendarycases", { detail: getLegendaryCasesOwned() }));
    syncLiveField("legendaryCases");
  }
  function getExoticCasesOwned() {
    const n = parseInt(localStorage.getItem(EXOTIC_CASE_OWNED_KEY), 10);
    return isNaN(n) ? 0 : n;
  }
  function setExoticCasesOwned(n) {
    localStorage.setItem(EXOTIC_CASE_OWNED_KEY, String(Math.max(0, n)));
    document.dispatchEvent(new CustomEvent("nj:exoticcases", { detail: getExoticCasesOwned() }));
    syncLiveField("exoticCases");
  }

  // Converts LEGENDARY_CASE_COST regular wager cases into 1 Legendary case. Returns true/false.
  function convertToLegendaryCase() {
    if (raffleSpinsAvailable() < LEGENDARY_CASE_COST) return false;
    const s = getRaffleState();
    const wagered = getLifetimeWagered();
    const earnedSteps = Math.floor((wagered + 1e-9) / RAFFLE_WAGER_STEP);
    s.claimedSteps = Math.min((s.claimedSteps || 0) + LEGENDARY_CASE_COST, earnedSteps);
    setRaffleState(s);
    setLegendaryCasesOwned(getLegendaryCasesOwned() + 1);
    return true;
  }

  // Converts as many batches of LEGENDARY_CASE_COST regular cases as currently possible, in
  // one go. Returns the number of Legendary cases actually created (0 if none could be made).
  function convertAllToLegendaryCases() {
    let count = 0;
    while (convertToLegendaryCase()) count++;
    return count;
  }

  // Converts EXOTIC_CASE_COST Legendary cases into 1 Exotic case. Returns true/false.
  function convertToExoticCase() {
    if (getLegendaryCasesOwned() < EXOTIC_CASE_COST) return false;
    setLegendaryCasesOwned(getLegendaryCasesOwned() - EXOTIC_CASE_COST);
    setExoticCasesOwned(getExoticCasesOwned() + 1);
    return true;
  }

  // Converts as many batches of EXOTIC_CASE_COST Legendary cases as currently possible, in
  // one go. Returns the number of Exotic cases actually created (0 if none could be made).
  function convertAllToExoticCases() {
    let count = 0;
    while (convertToExoticCase()) count++;
    return count;
  }

  function getRaffleState() {
    try { return JSON.parse(localStorage.getItem(RAFFLE_KEY)) || { claimedSteps: 0 }; }
    catch { return { claimedSteps: 0 }; }
  }
  function setRaffleState(s) {
    localStorage.setItem(RAFFLE_KEY, JSON.stringify(s));
    // live-update the sidebar case badge in THIS tab immediately (storage events only fire
    // in other tabs), same pattern as nj:balance/nj:vault/nj:betlog below.
    document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
    pushLiveRaffleState();
  }
  function raffleSpinsAvailable() {
    const wagered = getLifetimeWagered();
    const earnedSteps = Math.floor((wagered + 1e-9) / RAFFLE_WAGER_STEP);
    const s = getRaffleState();
    const claimed = Math.min(s.claimedSteps || 0, earnedSteps);
    return Math.max(0, earnedSteps - claimed);
  }
  // ---------- wager case upgrades: Luck, Speed, Multiplier (each level 1-10, cap 10) ----------
  // Purchased with real cash. These make the wager case meaningfully better for players who
  // invest in it, on top of whatever rank-based odds boost they already have.
  const CASE_UPGRADE_MAX = 10;
  const CASE_UPGRADES = [
    { id: "luck", name: "Luck", desc: "Improves odds of landing Mini/Minor/Major/Grand and lowers the chance of no win.", icon: "sparkles" },
    { id: "speed", name: "Roll Speed", desc: "Shortens how long the case reel spins before landing.", icon: "bolt" },
  ];
  function getCaseUpgrades() {
    try {
      const raw = JSON.parse(localStorage.getItem(CASE_UPGRADE_KEY));
      // Payout Multiplier upgrade has been removed (it made case payouts too overpowered).
      // Any "multiplier" level saved from before is simply ignored going forward — it no
      // longer affects payouts at all.
      if (!raw || typeof raw !== "object") return { luck: 0, speed: 0, maxSlots: 0 };
      return { luck: raw.luck || 0, speed: raw.speed || 0, maxSlots: raw.maxSlots || 0 };
    } catch { return { luck: 0, speed: 0, maxSlots: 0 }; }
  }
  function setCaseUpgrades(s) {
    localStorage.setItem(CASE_UPGRADE_KEY, JSON.stringify(s));
    document.dispatchEvent(new CustomEvent("nj:caseupgrades", { detail: s }));
    return s;
  }
  // Cost curve: each level gets steadily more expensive, so maxing out all three is a real
  // cash sink for players who have plenty of spare balance sitting around.
  function caseUpgradeCost(id, currentLevel) {
    const lvl = currentLevel != null ? currentLevel : (getCaseUpgrades()[id] || 0);
    if (lvl >= CASE_UPGRADE_MAX) return null;
    const base = { luck: 400, speed: 250 }[id] || 400;
    return Math.round(base * Math.pow(1.55, lvl));
  }
  function caseUpgradeMaxed(id) {
    return (getCaseUpgrades()[id] || 0) >= CASE_UPGRADE_MAX;
  }
  function buyCaseUpgrade(id) {
    if (!CASE_UPGRADES.some((u) => u.id === id)) return false;
    const s = getCaseUpgrades();
    const lvl = s[id] || 0;
    if (lvl >= CASE_UPGRADE_MAX) return false;
    const cost = caseUpgradeCost(id, lvl);
    if (cost == null || getCashBalance() < cost) return false;
    addCashBalance(-cost);
    s[id] = lvl + 1;
    setCaseUpgrades(s);
    return true;
  }
  // How much faster the reel lands per speed level — scales the 5.2s animation/settle time
  // down toward a floor so it never becomes instant/unreadable.
  function caseSpinDurationMs() {
    const lvl = getCaseUpgrades().speed || 0;
    const base = 5300;
    const floor = 1800;
    return Math.round(base - (base - floor) * (lvl / CASE_UPGRADE_MAX));
  }

  // ---------- BLACK MARKET ----------
  const BLACKMARKET_KEY = "nj_blackmarket";       // { day: "dateString", items: [...], purchased: [ids] }
  const ACTIVE_BOOSTS_KEY = "nj_active_boosts";    // [{ id, type, pct, expiresAt }]

  const BM_CATALOG = [
    { id: "passive5",  label: "Passive Boost +5%",   type: "passive",  pct: 0.05, rare: false, chance: 0.25, durationMin: 40 },
    { id: "passive15", label: "Rare Passive Boost +25%", type: "passive", pct: 0.15, rare: true,  chance: 0.10, durationMin: 25 },
    { id: "rake10",    label: "Rakeback Boost +10%", type: "rakeback", pct: 0.10, rare: false, chance: 0.25, durationMin: 30 },
    { id: "rake15",    label: "Rare Rakeback Boost +15%", type: "rakeback", pct: 0.15, rare: true, chance: 0.15, durationMin: 15 },
    { id: "click10",   label: "Click Boost +10%",    type: "click",    pct: 0.10, rare: false, chance: 0.25, durationMin: 30 },
    { id: "click25",   label: "Rare Click Boost +25%", type: "click",  pct: 0.25, rare: true,  chance: 0.15, durationMin: 15 },
    { id: "wager5",    label: "Wager Bonus +5%",     type: "wager",    pct: 0.05, rare: true,  chance: 0.15, durationMin: 15 },
    { id: "gameover",  label: "Game Over Coupon",    type: "gameover", pct: 0,    rare: true,  chance: 0.05, durationMin: 0, maxAvailable: 1 },
  ];

  function getBlackMarketState() {
    const today = new Date().toDateString();
    let s;
    try { s = JSON.parse(localStorage.getItem(BLACKMARKET_KEY)); } catch { s = null; }
    if (!s || s.day !== today) {
      s = { day: today, items: rollBlackMarketItems(), purchased: [] };
      localStorage.setItem(BLACKMARKET_KEY, JSON.stringify(s));
    }
    return s;
  }
  function setBlackMarketState(s) {
    localStorage.setItem(BLACKMARKET_KEY, JSON.stringify(s));
  }
  function rollBlackMarketItems() {
    const items = [];
    BM_CATALOG.forEach((def) => {
      if (Math.random() > def.chance) return;
      const max = def.maxAvailable || 5;
      const count = def.maxAvailable ? 1 : (1 + Math.floor(Math.random() * max));
      items.push({ id: def.id, remaining: count, total: count });
    });
    return items;
  }
  function blackMarketPrice(def) {
    if (def.type === "gameover") return 50000;
    const base = def.rare ? 5000 : 500;
    return Math.round(base * (1 + def.pct * 10));
  }
  function buyBlackMarketItem(id) {
    const def = BM_CATALOG.find((d) => d.id === id);
    if (!def) return false;
    const s = getBlackMarketState();
    const entry = s.items.find((i) => i.id === id);
    if (!entry || entry.remaining <= 0) return false;
    const price = blackMarketPrice(def);
    if (getCashBalance() < price) return false;
    addCashBalance(-price);
    entry.remaining -= 1;
    s.purchased.push({ id, boughtAt: Date.now() });
    setBlackMarketState(s);
    return true;
  }
  function getInventory() {
    const s = getBlackMarketState();
    return s.purchased || [];
  }
  function getActiveBoosts() {
    let list;
    try { list = JSON.parse(localStorage.getItem(ACTIVE_BOOSTS_KEY)) || []; } catch { list = []; }
    const now = Date.now();
    list = list.filter((b) => b.expiresAt > now);
    localStorage.setItem(ACTIVE_BOOSTS_KEY, JSON.stringify(list));
    return list;
  }
  function setActiveBoosts(list) {
    localStorage.setItem(ACTIVE_BOOSTS_KEY, JSON.stringify(list));
  }
  function activateBoost(id) {
    const def = BM_CATALOG.find((d) => d.id === id);
    if (!def) return false;
    const s = getBlackMarketState();
    const idx = s.purchased.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    s.purchased.splice(idx, 1);
    setBlackMarketState(s);

    if (def.type === "gameover") {
      const log = getBetLog();
      const lastLoss = [...log].reverse().find((b) => !b.won);
      if (lastLoss) addCashBalance(lastLoss.bet);
      notify(lastLoss ? `Game Over Coupon used — recovered ${fmtMoney(lastLoss.bet)}.` : "No recent loss found to recover.");
      return true;
    }

    const boosts = getActiveBoosts();
    boosts.push({ id, type: def.type, pct: def.pct, expiresAt: Date.now() + def.durationMin * 60000 });
    setActiveBoosts(boosts);
    notify(`${def.label} activated!`);
    return true;
  }
  function activeBoostPct(type) {
    return getActiveBoosts().filter((b) => b.type === type).reduce((sum, b) => sum + b.pct, 0);
  }

  // ---------- wager case batch-size upgrade: "Extra Slots" ----------
  // A one-time, buy-once-and-done upgrade (not leveled like Luck/Speed/Multiplier). Base batch
  // size is 5 cases at once; buying this raises it to CASE_BATCH_MAX (10). Deliberately very
  // expensive since it doesn't change odds/payouts at all — purely a convenience/throughput
  // upgrade for players who have a lot of cases stacked up.
  const CASE_BATCH_BASE = 5;
  const CASE_BATCH_MAX = 10;
  const CASE_BATCH_UPGRADE_COST = 250000;
  function hasCaseBatchUpgrade() {
    return !!getCaseUpgrades().maxSlots;
  }
  function caseBatchMax() {
    return hasCaseBatchUpgrade() ? CASE_BATCH_MAX : CASE_BATCH_BASE;
  }
  function buyCaseBatchUpgrade() {
    if (hasCaseBatchUpgrade()) return false;
    if (getCashBalance() < CASE_BATCH_UPGRADE_COST) return false;
    addCashBalance(-CASE_BATCH_UPGRADE_COST);
    const s = getCaseUpgrades();
    s.maxSlots = 1;
    setCaseUpgrades(s);
    return true;
  }

  // ---------- combine cases: 25 regular cases -> 1 Combine spin ----------
  // Consumes LEGENDARY_CASE_COST case openings (the same currency spent by spinRaffleWheel).
  // Odds are the SAME weight curve as the normal wheel (raffleOddsForRank) — just shifted up one
  // tier: whatever weight/payout the normal wheel gives "none" is used for "mini" here, "mini"'s
  // becomes "minor"'s, "minor"'s becomes "major"'s, "major"'s becomes "grand"'s, and "grand"'s
  // becomes "legendary"'s. That means "no win" can never land (mini's slot absorbs it), but
  // Legendary is exactly as rare as Grand is on a normal case — nothing here is guaranteed.
  const COMBINE_TIER_SHIFT = { mini: "none", minor: "mini", major: "minor", grand: "major", legendary: "grand" };
  const COMBINE_TIERS = [
    { key: "mini",      label: "Mini" },
    { key: "minor",     label: "Minor" },
    { key: "major",     label: "Major" },
    { key: "grand",     label: "Grand" },
    { key: "legendary", label: LEGENDARY_TIER.label },
  ];
  // Odds/rarity are borrowed from the normal wheel's weights (shifted up a tier, same as
  // before) so Legendary is exactly as rare as Grand is on a normal case. Payouts, though, get
  // their OWN dedicated curve here rather than reusing raffleOddsForRank's payout table — that
  // table's "none" tier pays $0 by design (it's the no-win outcome), and directly reusing it for
  // Combine's "mini" slot silently made every Mini combine result worth nothing. Combine can
  // never land on a $0 outcome, so every tier below needs its own real payout floor, and
  // Legendary in particular is meant to meaningfully beat what Grand pays on a normal case.
  function combineOddsForRank(tier) {
    const t = Math.max(0, tier || 0);
    const rankBoost = Math.min(1, t / RANK_TOTAL_TIERS);
    const { weights } = raffleOddsForRank(tier);
    const shiftedWeights = {};
    Object.keys(COMBINE_TIER_SHIFT).forEach((combineKey) => {
      shiftedWeights[combineKey] = weights[COMBINE_TIER_SHIFT[combineKey]];
    });
    const payouts = {
      mini:      15 + rankBoost * 35,      // floor well above the normal wheel's $1-3 Mini
      minor:     50 + rankBoost * 150,
      major:     200 + rankBoost * 800,
      grand:     750 + rankBoost * 2250,
      legendary: 2000 + rankBoost * 8000,  // meaningfully above what Grand alone ever paid
    };
    return { weights: shiftedWeights, payouts };
  }
  function canOpenLegendaryCase() {
    return getLegendaryCasesOwned() >= 1;
  }
  // Opens ONE already-converted Legendary case (does NOT consume regular cases — that
  // happens at conversion time via convertToLegendaryCase). Returns { tier, amount }, or
  // null if the player has no Legendary cases in stock.
  function openLegendaryCase() {
    if (!canOpenLegendaryCase()) return null;
    setLegendaryCasesOwned(getLegendaryCasesOwned() - 1);

    const rankTier = rankStats().tier;
    const { weights, payouts } = combineOddsForRank(rankTier);
    const total = COMBINE_TIERS.reduce((sum, t) => sum + weights[t.key], 0);
    let roll = Math.random() * total;
    let picked = COMBINE_TIERS[0].key;
    for (const t of COMBINE_TIERS) {
      if (roll < weights[t.key]) { picked = t.key; break; }
      roll -= weights[t.key];
    }
    const amount = Math.round((payouts[picked] || 0) * 100) / 100;
    if (amount > 0) addBalance(amount);
    return { tier: picked, amount };
  }

  // ---------- Exotic cases: shift the Legendary odds table up ANOTHER tier. "Mini" is
  // dropped entirely and "Minor" takes its slot; Exotic (new top tier) pays 3x whatever
  // Legendary's OWN top payout would have been. ----------
  const EXOTIC_TIERS = [
    { key: "minor",     label: "Minor" },
    { key: "major",     label: "Major" },
    { key: "grand",     label: "Grand" },
    { key: "legendary", label: LEGENDARY_TIER.label },
    { key: "exotic",    label: EXOTIC_TIER.label },
  ];
  const EXOTIC_TIER_SHIFT = { minor: "mini", major: "minor", grand: "major", legendary: "grand", exotic: "legendary" };
  function exoticOddsForRank(tier) {
    const { weights: cWeights, payouts: cPayouts } = combineOddsForRank(tier);
    const weights = {};
    Object.keys(EXOTIC_TIER_SHIFT).forEach((k) => { weights[k] = cWeights[EXOTIC_TIER_SHIFT[k]]; });
    const EXOTIC_PAYOUT_MULT = 1.5; // Exotic pays this much more than the equivalent Legendary-case tier
    const payouts = {
      minor: cPayouts.minor * EXOTIC_PAYOUT_MULT,
      major: cPayouts.major * EXOTIC_PAYOUT_MULT,
      grand: cPayouts.grand * EXOTIC_PAYOUT_MULT,
      legendary: cPayouts.legendary * EXOTIC_PAYOUT_MULT,
      exotic: cPayouts.legendary * 3 // still 3x Legendary's top, now also boosted 1.5x
    };
    return { weights, payouts };
  }
  function canOpenExoticCase() {
    return getExoticCasesOwned() >= 1;
  }
  function openExoticCase() {
    if (!canOpenExoticCase()) return null;
    setExoticCasesOwned(getExoticCasesOwned() - 1);

    const rankTier = rankStats().tier;
    const { weights, payouts } = exoticOddsForRank(rankTier);
    const total = EXOTIC_TIERS.reduce((sum, t) => sum + weights[t.key], 0);
    let roll = Math.random() * total;
    let picked = EXOTIC_TIERS[0].key;
    for (const t of EXOTIC_TIERS) {
      if (roll < weights[t.key]) { picked = t.key; break; }
      roll -= weights[t.key];
    }
    const amount = Math.round((payouts[picked] || 0) * 100) / 100;
    if (amount > 0) addBalance(amount);
    return { tier: picked, amount };
  }

  function raffleOddsForRank(tier) {
    const t = Math.max(0, tier || 0);
    const rankBoost = Math.min(1, t / RANK_TOTAL_TIERS); // 0 (unranked) .. 1 (max rank)
    const luckLvl = Math.max(0, Math.min(CASE_UPGRADE_MAX, getCaseUpgrades().luck || 0));
    const luckBoost = luckLvl / CASE_UPGRADE_MAX; // 0 (no upgrade) .. 1 (max luck level)
    // Prizes are intentionally hard to land by default — "Better luck next time" clearly
    // dominates the wheel, and Major/Grand in particular are rare unless the player has
    // invested rank and/or luck levels into shifting the odds. The luck upgrade is the main
    // lever a rich, high-rank player has to make cases feel worth opening again.
    const weights = {
      none:  Math.max(38, 88 - rankBoost * 14 - luckBoost * 36),
      mini:  8 + rankBoost * 3 + luckBoost * 10,
      minor: 3 + rankBoost * 3 + luckBoost * 9,
      major: 0.7 + rankBoost * 2.4 + luckBoost * 6,
      grand: 0.12 + rankBoost * 0.6 + luckBoost * 2,
    };
    const payouts = {
      mini:  1 + rankBoost * 2,
      minor: 5 + rankBoost * 15,
      major: 40 + rankBoost * 260,
      grand: 300 + rankBoost * 2700,
    };
    return { weights, payouts };
  }
  function spinRaffleWheel() {
    if (raffleSpinsAvailable() <= 0) return null;
    const s = getRaffleState();
    const wagered = getLifetimeWagered();
    const earnedSteps = Math.floor((wagered + 1e-9) / RAFFLE_WAGER_STEP);
    s.claimedSteps = Math.min((s.claimedSteps || 0) + 1, earnedSteps);
    setRaffleState(s);
    const tier = rankStats().tier;
    const { weights, payouts } = raffleOddsForRank(tier);
    const total = RAFFLE_TIERS.reduce((sum, t) => sum + weights[t.key], 0);
    let roll = Math.random() * total;
    let picked = RAFFLE_TIERS[0].key;
    for (const t of RAFFLE_TIERS) {
      if (roll < weights[t.key]) { picked = t.key; break; }
      roll -= weights[t.key];
    }
    const amount = Math.round((payouts[picked] || 0) * 100) / 100;
    if (amount > 0) addBalance(amount);
    return { tier: picked, amount };
  }

  // ---------- shared favorites ----------
  function getFavorites() {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || ["limbo"]; }
    catch { return ["limbo"]; }
  }
  function setFavorites(list) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
  }
  function toggleFavorite(id) {
    const list = getFavorites();
    const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
    setFavorites(next);
    return next;
  }

  // ---------- shared bet log (persists across pages/tabs/games; drives the live-stats graph) ----------
  function getBetLog() {
    try {
      const raw = JSON.parse(localStorage.getItem(BETLOG_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }
  function setBetLog(list) {
    localStorage.setItem(BETLOG_KEY, JSON.stringify(list));
    document.dispatchEvent(new CustomEvent("nj:betlog", { detail: list }));
  }
  function getGameResets() {
    try { return JSON.parse(localStorage.getItem(GAME_RESETS_KEY)) || {}; } catch { return {}; }
  }
  function setGameReset(gameId) {
    const resets = getGameResets();
    resets[gameId] = Date.now();
    localStorage.setItem(GAME_RESETS_KEY, JSON.stringify(resets));
  }
  function getResetTime(gameId) {
    const resets = getGameResets();
    return resets[gameId] || 0;
  }
  function getLifetimeWagered() {
    const v = parseFloat(localStorage.getItem(LIFETIME_WAGERED_KEY));
    return isNaN(v) ? 0 : v;
  }
  function addLifetimeWagered(amount) {
    const next = getLifetimeWagered() + (amount || 0) * (1 + activeBoostPct("wager"));
    localStorage.setItem(LIFETIME_WAGERED_KEY, String(next));
    // wagering can cross a $500 step and grant a new case — refresh the sidebar badge live.
    document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
    syncLiveField("lifetimeWagered");
    return next;
  }
  function getRecentWins() {
    try {
      const raw = JSON.parse(localStorage.getItem(RECENT_WINS_KEY));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }
  function setRecentWins(list) {
    localStorage.setItem(RECENT_WINS_KEY, JSON.stringify(list));
  }
  function addBetEntry(entry) {
    // A demo bet (no money actually wagered — bet amount is 0) must not move the
    // live-stats graph, rank progress, rakeback, or Recent Wins. Every game in the
    // catalog represents "demo play" as a real round placed with a $0 bet amount,
    // so bailing out here for any non-positive bet covers demo mode everywhere
    // without each game needing its own demo-mode check before calling this.
    if (!entry || !(entry.bet > 0)) return getBetLog();

    const list = getBetLog();
    const record = { time: Date.now(), ...entry };
    list.push(record);
    if (list.length > 5000) list.shift();
    setBetLog(list);
    addLifetimeWagered(entry.bet || 0);
    accrueRakeback(entry.bet || 0);
    // A bet placed while Reward is the active currency chips away at the wagering requirement
    // that unlocks converting reward balance to cash — see addRewardWagered/rewardConvertibleNow.
    if (getActiveCurrency() === "reward") addRewardWagered(entry.bet || 0);
    // Recent Wins is stored independently of the live-stats bet log, so resetting the graph
    // (resetBetLog) never wipes out the lobby's "Recent Wins" strip.
    if (entry.won && entry.profit > 0) {
      const wins = getRecentWins();
      wins.push(record);
      if (wins.length > 200) wins.shift();
      setRecentWins(wins);
    }
    pushLiveBet(record);
    return list;
  }
  // Resets only the live-stats graph / bet history — must NOT touch rank progress, wheel spins,
  // or the Recent Wins strip, all of which are tracked separately.
  function resetBetLog() {
    setBetLog([]);
    return [];
  }

  // ---------- active round persistence (survive accidental navigation mid-round) ----------
  // A single slot (not one per game) is enough since only one game can be "active" at a time —
  // the player is always on exactly one game page. Games call saveActiveRound(gameId, data)
  // every time their round state changes AFTER a bet has been placed, and clearActiveRound()
  // the instant the round settles (win or loss) or is cashed out. On load, a game calls
  // loadActiveRound(gameId) and, if it gets a match, restores from `data` instead of showing
  // the idle/pre-bet screen — so leaving mid-round (e.g. clicking the lobby link by accident)
  // no longer silently forfeits the bet or drops the board.
  function saveActiveRound(gameId, data) {
    try {
      localStorage.setItem(ACTIVE_ROUND_KEY, JSON.stringify({ game: gameId, data, savedAt: Date.now() }));
    } catch {}
  }
  function loadActiveRound(gameId) {
    try {
      const raw = JSON.parse(localStorage.getItem(ACTIVE_ROUND_KEY));
      if (raw && raw.game === gameId && raw.data) return raw.data;
    } catch {}
    return null;
  }
  function clearActiveRound(gameId) {
    try {
      const raw = JSON.parse(localStorage.getItem(ACTIVE_ROUND_KEY));
      // only clear if it's this game's round (or unreadable) so games never step on each other
      if (!raw || raw.game === gameId) localStorage.removeItem(ACTIVE_ROUND_KEY);
    } catch { localStorage.removeItem(ACTIVE_ROUND_KEY); }
  }

  // Real recent wins by the actual player (most recent winning bets), for the lobby "Recent Wins" strip.
  function getRecentPlayerWins(limit = 60) {
    const catalog = Array.isArray(window.GAME_CATALOG) ? window.GAME_CATALOG : [];
    const nameFor = (id) => (catalog.find((g) => g.id === id) || {}).name || id || "Game";
    return getRecentWins()
      .slice()
      .reverse()
      .slice(0, limit)
      .map((b) => ({ game: nameFor(b.game), gameId: b.game, amount: (b.bet + b.profit).toFixed(2), bet: b }));
  }
  window.addEventListener("storage", (e) => {
    if (e.key === BETLOG_KEY) document.dispatchEvent(new CustomEvent("nj:betlog", { detail: getBetLog() }));
    if (e.key === RAFFLE_KEY || e.key === LIFETIME_WAGERED_KEY) document.dispatchEvent(new CustomEvent("nj:cases", { detail: raffleSpinsAvailable() }));
  });

  // ---------- earn (incremental / clicker) game ----------
  // Upgrades are split into two tracks:
  //   "clicker"    — boosts manual click value (kind: click / clickPct)
  //   "automation" — boosts passive $/sec generation (kind: passive / passivePct)
  // Every upgrade has a maxLevel so the grind eventually caps out instead of scaling forever.
  // Costs scale ~1.55x per level — noticeably steeper than a casual idle game, on purpose.
  // All upgrades in both tracks are capped at 5 levels each. The automation track in
  // particular is tuned so that maxing out every automation upgrade (5/5 on all six) lands
  // on exactly $15/sec passive — no more, no matter how much cash is dumped into it:
  //   flat rate at max = (0.10+0.30+0.50+0.70+0.80) * 5 levels = 12/sec
  //   passive % multiplier at max = 1 + 5 * 5% = 1.25x
  //   12 * 1.25 = 15/sec
  const EARN_UPGRADES = [
    // ---- clicker track ----
    { id: "grip",         name: "Steadier Grip",      desc: "+$0.01 per click",   icon: "bolt",     kind: "click",      category: "clicker",    baseCost: 50,     baseAmt: 0.01, maxLevel: 5 },
    { id: "combo",        name: "Combo Multiplier",   desc: "+4% click value",    icon: "trend",    kind: "clickPct",   category: "clicker",    baseCost: 150,    baseAmt: 0.04, maxLevel: 5 },
    { id: "focus",        name: "Focused Strikes",    desc: "+$0.05 per click",   icon: "sparkles", kind: "click",      category: "clicker",    baseCost: 900,    baseAmt: 0.05, maxLevel: 5 },
    { id: "adrenaline",   name: "Adrenaline Rush",    desc: "+9% click value",    icon: "activity", kind: "clickPct",   category: "clicker",    baseCost: 5000,   baseAmt: 0.09, maxLevel: 5 },
    { id: "goldenfinger", name: "Golden Finger",      desc: "+$0.35 per click",   icon: "spark",    kind: "click",      category: "clicker",    baseCost: 45000,  baseAmt: 0.35, maxLevel: 5 },
    // ---- automation track (tuned to cap at exactly $15/sec — see note above) ----
    { id: "intern",       name: "Hire an Intern",     desc: "+$0.10/sec passive", icon: "coin",     kind: "passive",    category: "automation", baseCost: 120,    baseAmt: 0.10, maxLevel: 5 },
    { id: "booth",        name: "Cashier Booth",      desc: "+$0.30/sec passive", icon: "coin",     kind: "passive",    category: "automation", baseCost: 900,    baseAmt: 0.30, maxLevel: 5 },
    { id: "vault",        name: "Automated Vault",    desc: "+$0.50/sec passive", icon: "safe",     kind: "passive",    category: "automation", baseCost: 6000,   baseAmt: 0.50, maxLevel: 5 },
    { id: "factory",      name: "Mint Factory",       desc: "+$0.70/sec passive", icon: "wrench",   kind: "passive",    category: "automation", baseCost: 42000,  baseAmt: 0.70, maxLevel: 5 },
    { id: "syndicate",    name: "Neon Syndicate",     desc: "+$0.80/sec passive", icon: "gift",     kind: "passive",    category: "automation", baseCost: 260000, baseAmt: 0.80, maxLevel: 5 },
    { id: "manager",      name: "Efficiency Manager", desc: "+5% passive rate",   icon: "settings", kind: "passivePct", category: "automation", baseCost: 20000,  baseAmt: 0.05, maxLevel: 5 },
  ];
  // Anti-macro: real thumbs can't sustain much more than ~12-13 taps/sec for long. Anything
  // faster than this within a rolling 1-second window is simply ignored (no balance, no click
  // credit) rather than silently rewarded — so AFK autoclickers/macros stop being worth running.
  const CLICK_RATE_CAP = 12; // max counted clicks per rolling second
  let clickTimestamps = [];
  // Unclaimed passive earnings ("pendingPassive") are capped at this many hours' worth of the
  // player's CURRENT passive rate — so walking away for days doesn't let it balloon forever.
  // Claiming resets pendingPassive to 0 (see earnClaimPassive), which also resets this cap window.
  const PASSIVE_CAP_HOURS = 10;
  // Flat absolute ceiling on unclaimed passive earnings, on top of the hours-based cap above —
  // whichever cap is smaller wins. With automation now maxing out at $15/sec (see EARN_UPGRADES
  // note), a maxed-out build would otherwise be able to bank up to $270,000 (5 hrs * $15/sec)
  // in unclaimed passive; this keeps it from ever exceeding $25k regardless of build or how
  // long the player is away.
  const PASSIVE_CAP_ABS = 150000;
  // ---------- autoclick detection ----------
  const AUTOCLICK_KEY = "nj_autoclick_state"; // { day, offenseCount, lockUntil }
  const AUTOCLICK_WARN_WINDOW_MS = 150000; // sustained max-rate clicking for this long triggers a check
  let autoclickTimestamps = [];
  let autoclickChallengeShown = false;

  function getAutoclickState() {
    try {
      const s = JSON.parse(localStorage.getItem(AUTOCLICK_KEY)) || {};
      const today = new Date().toDateString();
      if (s.day !== today) return { day: today, offenseCount: 0, lockUntil: 0 };
      return s;
    } catch { return { day: new Date().toDateString(), offenseCount: 0, lockUntil: 0 }; }
  }
  function setAutoclickState(s) { localStorage.setItem(AUTOCLICK_KEY, JSON.stringify(s)); }
  function isAutoclickLocked() {
    const s = getAutoclickState();
    return s.lockUntil > Date.now() ? s.lockUntil : 0;
  }
  function recordAutoclickOffense() {
    const s = getAutoclickState();
    s.offenseCount += 1;
    if (s.offenseCount === 1) {
      setAutoclickState(s);
      return { type: "warning" };
    }
    const lockMinutes = 5 * Math.pow(2, s.offenseCount - 2); // 5, 10, 20, 40...
    s.lockUntil = Date.now() + lockMinutes * 60000;
    setAutoclickState(s);
    return { type: "lock", minutes: lockMinutes };
  }
  function clearAutoclickOffense() {
    // A passed challenge doesn't erase the offense count (still resets daily),
    // it just avoids escalating further right now.
  }

  // Called on every real click attempt. Returns true if clicking should be BLOCKED right now.
  function autoclickGate() {
    const lockUntil = isAutoclickLocked();
    if (lockUntil) return true;

    const now = Date.now();
    autoclickTimestamps.push(now);
    autoclickTimestamps = autoclickTimestamps.filter((t) => now - t < AUTOCLICK_WARN_WINDOW_MS + 2000);

    // If clicks have been landing at (or above) the rate cap continuously for the
    // whole window, treat that as suspicious and pop the human-check challenge.
    const clicksInWindow = autoclickTimestamps.filter((t) => now - t < AUTOCLICK_WARN_WINDOW_MS).length;
    const sustainedMaxRate = clicksInWindow >= AUTOCLICK_WARN_WINDOW_MS / 1000 * CLICK_RATE_CAP * 0.9;
    if (sustainedMaxRate && !autoclickChallengeShown) {
      autoclickChallengeShown = true;
      openAutoclickChallenge();
    }
    return false;
  }

  function openAutoclickChallenge() {
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-autoclick-overlay", "");
    const targetClicks = 3;
    let done = 0;
    wrap.innerHTML = `
      <div class="shell-modal-box" style="text-align:center;">
        <div class="shell-modal-head"><h3>${svg("bolt")} Quick check</h3></div>
        <p style="color:#a3aec2;font-size:12px;line-height:1.6;">We noticed unusually fast, steady clicking. Tap the button below ${targetClicks} times to confirm you're really here.</p>
        <button class="place-bet-btn" data-autoclick-confirm style="margin-top:10px;">Tap me (<span data-autoclick-count>0</span>/${targetClicks})</button>
      </div>`;
    document.body.appendChild(wrap);
    const btn = wrap.querySelector("[data-autoclick-confirm]");
    const countEl = wrap.querySelector("[data-autoclick-count]");
    let lastTap = 0;
    btn.onclick = () => {
      const now = Date.now();
      // require genuinely spaced-out taps — a script mashing this button also fails the check
      if (now - lastTap < 220) return;
      lastTap = now;
      done++;
      countEl.textContent = done;
      if (done >= targetClicks) {
        wrap.remove();
        autoclickChallengeShown = false;
        autoclickTimestamps = [];
      }
    };
    // If the challenge sits unanswered too long, treat it as failed.
    setTimeout(() => {
      if (!wrap.isConnected) return;
      wrap.remove();
      autoclickChallengeShown = false;
      autoclickTimestamps = [];
      const result = recordAutoclickOffense();
      if (result.type === "warning") {
        notify("Unusual clicking detected. Next time, clicking will be temporarily locked.");
      } else {
        notify(`Clicking locked for ${result.minutes} minutes due to repeated automated clicking.`);
        renderDevFloatingPanel(); // harmless no-op refresh hook; keeps UI consistent if panel open
      }
    }, 12000);
  }
  function defaultEarnState() {
    const levels = {}; EARN_UPGRADES.forEach((u) => levels[u.id] = 0);
    return { clickBase: 0.03, levels, pendingPassive: 0, lastTick: Date.now(), totalClicks: 0, totalClaimed: 0 };
  }
  function getEarnState() {
    try {
      const raw = JSON.parse(localStorage.getItem(EARN_KEY));
      if (!raw || typeof raw !== "object") return defaultEarnState();
      const def = defaultEarnState();
      const state = { ...def, ...raw, levels: { ...def.levels, ...(raw.levels || {}) } };
      return earnMigrateLevelCap(state);
    } catch { return defaultEarnState(); }
  }
  // One-time migration: clicker/automation upgrades used to allow up to 15-50 levels each;
  // they're now capped at 5 (see EARN_UPGRADES above). Anyone who had already bought past
  // level 5 on any upgrade before the cap dropped gets clamped back down to level 5, and
  // whatever cash they spent buying those now-rolled-back levels is refunded — to the REWARD
  // balance, not cash, per spec — so the spend doesn't just silently vanish. Runs once per
  // save file, guarded by the `levelCapMigrated` flag persisted on the state itself.
  function earnMigrateLevelCap(state) {
    if (state.levelCapMigrated) return state;
    let refund = 0;
    EARN_UPGRADES.forEach((u) => {
      const lvl = state.levels[u.id] || 0;
      if (u.maxLevel != null && lvl > u.maxLevel) {
        // Refund the cost of every level above the new cap, using the same 1.55x-per-level
        // cost curve earnUpgradeCost() uses (cost to go from level n to n+1 = baseCost * 1.55^n).
        for (let n = u.maxLevel; n < lvl; n++) {
          refund += Math.round(u.baseCost * Math.pow(1.55, n));
        }
        state.levels[u.id] = u.maxLevel;
      }
    });
    state.levelCapMigrated = true;
    setEarnState(state);
    if (refund > 0) {
      addRewardBalance(refund);
      notify(`Upgrade levels were capped at 5 — refunded ${fmtMoney(refund)} to your reward balance.`);
      addNotification({ type: "earnings", title: "Upgrade levels rebalanced", detail: `Levels above 5 were rolled back and ${fmtMoney(refund)} was refunded to your reward balance.` });
    }
    return state;
  }
  function setEarnState(s) {
    localStorage.setItem(EARN_KEY, JSON.stringify(s));
    document.dispatchEvent(new CustomEvent("nj:earn", { detail: s }));
    pushLiveAccountState();
    return s;
  }
  // Returns null once an upgrade is at its level cap — callers must treat null as "can't buy".
  function earnUpgradeCost(id) {
    const u = EARN_UPGRADES.find((x) => x.id === id);
    if (!u) return null;
    const lvl = getEarnState().levels[id] || 0;
    if (u.maxLevel != null && lvl >= u.maxLevel) return null;
    return Math.round(u.baseCost * Math.pow(1.55, lvl));
  }
  function earnUpgradeMaxed(id) {
    const u = EARN_UPGRADES.find((x) => x.id === id);
    if (!u || u.maxLevel == null) return false;
    return (getEarnState().levels[id] || 0) >= u.maxLevel;
  }
  function earnClickValue(state) {
    let base = state.clickBase;
    EARN_UPGRADES.filter((u) => u.kind === "click").forEach((u) => base += u.baseAmt * (state.levels[u.id] || 0));
    let mult = 1;
    EARN_UPGRADES.filter((u) => u.kind === "clickPct").forEach((u) => mult += u.baseAmt * (state.levels[u.id] || 0));
    return base * mult * (1 + activeBoostPct("click"));
  }
  function earnPassiveRate(state) {
    let rate = 0;
    EARN_UPGRADES.filter((u) => u.kind === "passive").forEach((u) => rate += u.baseAmt * (state.levels[u.id] || 0));
    let mult = 1;
    EARN_UPGRADES.filter((u) => u.kind === "passivePct").forEach((u) => mult += u.baseAmt * (state.levels[u.id] || 0));
    return rate * mult * (1 + activeBoostPct("passive"));
  }
  // accrue passive earnings into pendingPassive based on elapsed real time since lastTick
  function earnTick() {
    const state = getEarnState();
    const now = Date.now();
    const elapsedSec = Math.max(0, (now - (state.lastTick || now)) / 1000);
    const rate = earnPassiveRate(state);
    if (elapsedSec > 0 && rate > 0) state.pendingPassive = (state.pendingPassive || 0) + rate * elapsedSec;
    // Cap unclaimed passive earnings at whichever is SMALLER: PASSIVE_CAP_HOURS worth of the
    // CURRENT passive rate, or the flat PASSIVE_CAP_ABS ceiling. Recomputed every tick (not
    // fixed at claim time) so buying a new automation upgrade raises the hours-based cap
    // immediately rather than leaving old progress stuck under a stale ceiling — but the flat
    // cap always applies too, so unclaimed passive can never balloon past $25k no matter the
    // build or how long the player is away.
    const hourCap = rate > 0 ? rate * PASSIVE_CAP_HOURS * 3600 : Infinity;
    const cap = Math.min(hourCap, PASSIVE_CAP_ABS);
    if (state.pendingPassive > cap) state.pendingPassive = cap;
    state.lastTick = now;
    return setEarnState(state);
  }
  // Returns the $ earned, or 0 if the click was dropped for exceeding the rate cap.
  function earnClick() {
    const lockUntil = isAutoclickLocked();
    if (lockUntil) {
      const mins = Math.ceil((lockUntil - Date.now()) / 60000);
      notify(`Clicking is temporarily locked (${mins}m remaining) due to automated clicking.`);
      return 0;
    }
    if (autoclickGate()) return 0;

    const now = Date.now();
    clickTimestamps = clickTimestamps.filter((t) => now - t < 1000);
    if (clickTimestamps.length >= CLICK_RATE_CAP) return 0;
    clickTimestamps.push(now);
    const state = getEarnState();
    const value = earnClickValue(state);
    state.totalClicks += 1;
    addCashBalance(value);
    setEarnState(state);
    return value;
  }
  // Upgrades are a cash-only purchase — reward balance can never be spent here, per spec.
  function earnBuyUpgrade(id) {
    const state = earnTick();
    if (earnUpgradeMaxed(id)) return false;
    const cost = earnUpgradeCost(id);
    if (cost == null || getCashBalance() < cost) return false;
    addCashBalance(-cost);
    state.levels[id] = (state.levels[id] || 0) + 1;
    setEarnState(state);
    if (Date.now() - lastForcedPushAt > 800) {
      lastForcedPushAt = Date.now();
      persistActiveAccount();
      pushLiveAccountStateNow();
    } else {
      persistActiveAccount();
      pushLiveAccountState(); // falls back to the debounced version
    }
    return true;
  }
  function earnClaimPassive() {
    const state = earnTick();
    const amount = Math.floor((state.pendingPassive || 0) * 100) / 100;
    if (amount <= 0) return 0;
    state.pendingPassive = 0;
    state.totalClaimed = (state.totalClaimed || 0) + amount;
    addCashBalance(amount);
    setEarnState(state);
    if (Date.now() - lastForcedPushAt > 800) {
      lastForcedPushAt = Date.now();
      persistActiveAccount();
      pushLiveAccountStateNow();
    } else {
      persistActiveAccount();
      pushLiveAccountState(); // falls back to the debounced version
    }
    return amount;
  }

  // ---------- notifications ----------
  function getNotifications() {
    try { const raw = JSON.parse(localStorage.getItem(NOTIF_KEY)); return Array.isArray(raw) ? raw : []; }
    catch { return []; }
  }
  function setNotifications(list) {
    localStorage.setItem(NOTIF_KEY, JSON.stringify(list));
    document.dispatchEvent(new CustomEvent("nj:notifications", { detail: list }));
  }
  function addNotification({ type = "earnings", title, detail }) {
    const list = getNotifications();
    list.unshift({ id: Date.now() + Math.random().toString(16).slice(2), type, title, detail, time: Date.now(), read: false });
    if (list.length > 60) list.length = 60;
    setNotifications(list);
    return list;
  }
  function markNotificationsRead() {
    const list = getNotifications().map((n) => ({ ...n, read: true }));
    setNotifications(list);
  }
  function unreadNotificationCount() {
    return getNotifications().filter((n) => !n.read).length;
  }
  function timeAgo(ts) {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }

  // ---------- recent searches ----------
  function getRecentSearches() {
    try { const raw = JSON.parse(localStorage.getItem(RECENT_SEARCH_KEY)); return Array.isArray(raw) ? raw : []; }
    catch { return []; }
  }
  function addRecentSearch(term) {
    const clean = term.trim();
    if (!clean) return getRecentSearches();
    let list = getRecentSearches().filter((t) => t.toLowerCase() !== clean.toLowerCase());
    list.unshift(clean);
    if (list.length > 8) list.length = 8;
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(list));
    return list;
  }
  function removeRecentSearch(term) {
    const list = getRecentSearches().filter((t) => t !== term);
    localStorage.setItem(RECENT_SEARCH_KEY, JSON.stringify(list));
    return list;
  }

  // ---------- shared chip sound (select + place) ----------
  let sharedAudioCtx = null;
  const getSharedCtx = () => { if (!sharedAudioCtx) sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)(); return sharedAudioCtx; };
  function playChipSound(kind = "select", volumePct = 100) {
    const v = volumePct / 100;
    if (v <= 0) return;
    try {
      const ctx = getSharedCtx();
      const now = ctx.currentTime;
      // two quick clicky knocks that read as a poker chip
      const knock = (t, freq, gain, dur) => {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(freq, t);
        osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + dur);
        g.gain.setValueAtTime(gain * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + dur);
        osc.connect(g).connect(ctx.destination);
        osc.start(t); osc.stop(t + dur);
      };
      if (kind === "place") {
        knock(now, 900, 0.16, 0.05);
        knock(now + 0.045, 700, 0.14, 0.06);
        knock(now + 0.09, 850, 0.1, 0.05);
      } else {
        knock(now, 1000, 0.12, 0.04);
      }
    } catch {}
  }

  // ---------- dice-roll rattle + win ding (used by dice.html's roll animation) ----------
  // A short burst of quick clicky ticks (like dice tumbling), playing for the duration the
  // caller specifies so it can be timed to match however long the visual roll animation runs.
  function playDiceRollSound(durationMs = 700, volumePct = 100) {
    const v = volumePct / 100;
    if (v <= 0) return;
    try {
      const ctx = getSharedCtx();
      const now = ctx.currentTime;
      const durationSec = durationMs / 1000;
      const tickCount = Math.max(6, Math.round(durationSec * 14));
      for (let i = 0; i < tickCount; i++) {
        // ticks start fast and spread out toward the end, like a die settling
        const progress = i / tickCount;
        const t = now + progress * progress * durationSec;
        const freq = 260 + Math.random() * 90;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "square";
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0.05 * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
        osc.connect(g).connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.03);
      }
    } catch {}
  }
  // A clean bright "ding" for landing on the winning side of the bar.
  function playWinDing(volumePct = 100) {
    const v = volumePct / 100;
    if (v <= 0) return;
    try {
      const ctx = getSharedCtx();
      const now = ctx.currentTime;
      [1318.5, 1975.5].forEach((freq, i) => {
        const t = now + i * 0.03;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(freq, t);
        g.gain.setValueAtTime(0.18 * v, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        osc.connect(g).connect(ctx.destination);
        osc.start(t); osc.stop(t + 0.35);
      });
    } catch {}
  }

  // ---------- shared game-card art (used by lobby grid, search modal, recent wins) ----------
  function gameArtInner(game) {
    if (game && game.image) return `<img class="game-card-img" src="${game.image}" alt="${game.name || ""}" loading="lazy">`;
    if (game.art === "limbo") return `<div class="limbo-art-chips"><div class="limbo-chip back">x500</div><div class="limbo-chip front">x1000</div></div>`;
    if (game.art === "blackjack") return `<div class="bj-art-cards"><div class="bj-card back"></div><div class="bj-card face">A♣</div></div>`;
    if (game.art === "dice") return `<div class="dice-art-pair">
      <div class="dice-die back"><div class="dice-pip-grid"><span class="dice-pip p1"></span><span class="dice-pip p2"></span><span class="dice-pip p3"></span><span class="dice-pip p4"></span><span class="dice-pip p5"></span><span class="dice-pip p6"></span><span class="dice-pip p7"></span><span class="dice-pip p8"></span><span class="dice-pip p9"></span></div></div>
      <div class="dice-die front"><div class="dice-pip-grid"><span class="dice-pip p1"></span><span class="dice-pip p2"></span><span class="dice-pip p3"></span><span class="dice-pip p4"></span><span class="dice-pip p5"></span><span class="dice-pip p6"></span><span class="dice-pip p7"></span><span class="dice-pip p8"></span><span class="dice-pip p9"></span></div></div>
    </div>`;
    if (game.art === "keno") return `<div class="keno-art-gem"><div class="keno-gem-tile"></div><div class="keno-gem-shape"></div></div>`;
    if (game.art === "plinko") return `<div class="plinko-art-wrap">
        <div class="plinko-art-dot d1"></div><div class="plinko-art-dot d2"></div><div class="plinko-art-dot d3"></div>
        <div class="plinko-art-dot d4"></div><div class="plinko-art-dot d5"></div><div class="plinko-art-dot d6"></div>
        <div class="plinko-art-badge">10000<small>×</small></div>
        <div class="plinko-art-ring"></div>
      </div>`;
    if (game.art === "war") return `<div class="war-art-cards"><div class="war-card left">K♠</div><div class="war-vs-badge">VS</div><div class="war-card right">Q♥</div></div>`;
    if (game.art === "crash") return `<div class="crash-art-wrap">
        <div class="crash-art-sun"></div>
        <svg class="crash-art-line" viewBox="0 0 100 70" fill="none">
          <path d="M0 68 C 30 68, 46 66, 58 52 C 70 38, 72 20, 100 2 L 100 70 L 0 70 Z" fill="rgba(255,255,255,.18)"/>
          <path d="M0 68 C 30 68, 46 66, 58 52 C 70 38, 72 20, 100 2" stroke="#fff" stroke-width="4" stroke-linecap="round"/>
        </svg>
      </div>`;
    if (game.art === "chickencross") return `<div class="chicken-art-wrap">
        <div class="chicken-art-road"><div class="chicken-art-stripe"></div><div class="chicken-art-stripe"></div><div class="chicken-art-stripe"></div><div class="chicken-art-stripe"></div></div>
        <svg class="chicken-art-sign" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2 22 20H2Z"/><path d="M12 9v5M12 17h.01" stroke-linecap="round"/></svg>
        <svg class="chicken-art-bird" viewBox="0 0 60 70" fill="none">
          <ellipse cx="30" cy="46" rx="19" ry="20" fill="#fff"/>
          <circle cx="30" cy="20" r="13" fill="#fff"/>
          <path d="M17 15c-3-4-2-9 3-8" stroke="#ffcf7d" stroke-width="4" stroke-linecap="round" fill="none"/>
          <path d="M18 12c-1-3 1-5 3-4" stroke="#d63c3c" stroke-width="3" stroke-linecap="round" fill="none"/>
          <path d="M40 20 L52 22 L40 26Z" fill="#e08a2a"/>
          <circle cx="35" cy="17" r="2.4" fill="#1a1d2b"/>
          <path d="M20 62 L20 68 M40 62 L40 68" stroke="#e08a2a" stroke-width="4" stroke-linecap="round"/>
        </svg>
      </div>`;
    if (game.art === "dragontower") return `<div class="tower-art-wrap">
        <div class="tower-art-pillar left"></div><div class="tower-art-pillar right"></div>
        <svg class="tower-art-flame left" viewBox="0 0 40 60" fill="currentColor"><path d="M20 2c6 10 12 16 12 28a12 12 0 1 1-24 0c0-6 3-10 6-14-1 5 1 7 3 8-1-8 1-16 3-22Z"/></svg>
        <svg class="tower-art-flame right" viewBox="0 0 40 60" fill="currentColor"><path d="M20 2c6 10 12 16 12 28a12 12 0 1 1-24 0c0-6 3-10 6-14-1 5 1 7 3 8-1-8 1-16 3-22Z"/></svg>
        <svg class="tower-art-egg" viewBox="0 0 40 52" fill="none">
          <defs>
            <linearGradient id="towerEggGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#fff6de"/>
              <stop offset="55%" stop-color="#ffcf7d"/>
              <stop offset="100%" stop-color="#c9862f"/>
            </linearGradient>
          </defs>
          <path d="M20 2C10 14 3 26 3 35a17 17 0 0 0 34 0c0-9-7-21-17-33Z" fill="url(#towerEggGrad)"/>
          <path d="M20 10c-6 8-11 17-11 24a11 11 0 0 0 5 9" stroke="rgba(255,255,255,.55)" stroke-width="2" stroke-linecap="round" fill="none"/>
        </svg>
      </div>`;
    if (game.art === "hilo") return `<div class="hilo-art-cards"><div class="hilo-card back">▼</div><div class="hilo-card face">▲</div></div>`;
    if (game.art === "roulette") return `<div class="roulette-art-wrap">
        <svg class="roulette-art-legs" viewBox="0 0 60 30" fill="none" stroke="#e0a94f" stroke-width="3" stroke-linecap="round"><path d="M30 28 10 4M30 28 50 4M30 28 30 2"/></svg>
        <div class="roulette-art-wheel"><div class="roulette-art-ring"></div><div class="roulette-art-hub"></div><div class="roulette-art-ball"></div></div>
        <div class="roulette-art-chip"><span>6</span></div>
        <div class="roulette-art-felt">
          <div class="roulette-art-row"><span class="c red">3</span><span class="c black">6</span><span class="c red">9</span></div>
          <div class="roulette-art-row"><span class="c black">2</span><span class="c red">5</span><span class="c black">8</span></div>
          <div class="roulette-art-row"><span class="c red">1</span><span class="c black">4</span><span class="c red">7</span></div>
        </div>
      </div>`;
    if (game.art === "flip") return `<div class="flip-art-wrap">
        <div class="flip-art-arrow-ring"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10l6 6 6-6"/></svg></div>
        <div class="flip-art-coin"><div class="flip-art-coin-top"></div></div>
      </div>`;
    if (game.art === "mines") return `<div class="mines-art-wrap">
        <svg class="mines-art-diamond" viewBox="0 0 60 56" fill="none">
          <defs>
            <linearGradient id="minesDiaGrad" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="#e8f7ff"/>
              <stop offset="45%" stop-color="#7ecbff"/>
              <stop offset="100%" stop-color="#2f8fd6"/>
            </linearGradient>
          </defs>
          <path d="M12 4H48L58 20L30 54L2 20Z" fill="url(#minesDiaGrad)" stroke="#c8ecff" stroke-width="1.5" stroke-linejoin="round"/>
          <path d="M12 4 22 20 30 4Z" fill="rgba(255,255,255,.55)"/>
          <path d="M48 4 38 20 30 4Z" fill="rgba(255,255,255,.3)"/>
          <path d="M2 20H58L30 54Z" fill="rgba(20,80,140,.25)"/>
          <path d="M22 20 30 4 38 20 30 54Z" fill="rgba(255,255,255,.15)"/>
        </svg>
        <svg class="mines-art-bomb" viewBox="0 0 44 48" fill="none">
          <path d="M27 3c3 1 3 4 1 5.5" stroke="#e0a94f" stroke-width="2.6" stroke-linecap="round"/>
          <circle cx="30" cy="4" r="2.4" fill="#ffcf7d"/>
          <circle cx="20" cy="27" r="17" fill="#171a29"/>
          <circle cx="20" cy="27" r="17" fill="url(#minesBombGrad)"/>
          <defs><radialGradient id="minesBombGrad" cx="38%" cy="32%" r="70%">
            <stop offset="0%" stop-color="#4a5468"/><stop offset="55%" stop-color="#1c2030"/><stop offset="100%" stop-color="#0a0c14"/>
          </radialGradient></defs>
          <ellipse cx="14" cy="20" rx="5" ry="3.4" fill="rgba(255,255,255,.35)"/>
        </svg>
      </div>`;
    if (game.art === "aviamaster") return `<div class="avia-art-wrap">
        <div class="avia-art-cloud c1"></div><div class="avia-art-cloud c2"></div>
        <svg class="avia-art-plane" viewBox="0 0 80 64" fill="none">
          <ellipse cx="30" cy="24" rx="8" ry="20" fill="#e0524a" transform="rotate(90 30 24)"/>
          <path d="M12 24 C12 14, 20 8, 34 8 L34 40 C20 40, 12 34, 12 24Z" fill="#e0524a"/>
          <path d="M34 8 L58 8 C64 8, 68 12, 68 18 L68 30 C68 36, 64 40, 58 40 L34 40Z" fill="#f0623a"/>
          <rect x="4" y="20" width="14" height="8" rx="3" fill="#ffcf7d"/>
          <circle cx="6" cy="24" r="5" fill="#3a3d4a"/>
          <path d="M28 4 L28 44" stroke="#c9302c" stroke-width="6" stroke-linecap="round"/>
          <path d="M40 2 L40 46" stroke="#c9302c" stroke-width="5" stroke-linecap="round"/>
          <ellipse cx="66" cy="24" rx="10" ry="7" fill="#ffcf7d"/>
          <circle cx="66" cy="24" r="3" fill="#5a3a1a"/>
        </svg>
      </div>`;
    return `<span class="game-icon">GAME</span>`;
  }

  // ---------- chrome markup ----------
  function fmtMoney(n) {
    return "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Small filled coin icon matching whichever currency is currently active — green $ for cash,
  // purple R for reward balance.
  function currencyCoinHTML() {
    return svg(getActiveCurrency() === "reward" ? "rewardcoin" : "cashcoin");
  }

  function isSidebarCollapsed() { return localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1"; }
  function setSidebarCollapsed(collapsed) { localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0"); }

  // Originals/Slots dropdown open state persists across every page (not just the current one),
  // so once a player opens one it stays open site-wide until they close it themselves.
  function getRailDropdownState() {
    try { return JSON.parse(localStorage.getItem(RAIL_DROPDOWN_KEY)) || {}; }
    catch { return {}; }
  }
  function setRailDropdownState(s) { localStorage.setItem(RAIL_DROPDOWN_KEY, JSON.stringify(s)); }

  // small per-game glyph shown next to each sidebar sublink (distinct from the big card art)
  function gameSidebarIcon(art) {
    return ({
      limbo: svg("bolt"), blackjack: svg("spark"), dice: svg("grid"), keno: svg("sparkles"),
      plinko: svg("activity"), war: svg("trend"), crash: svg("trend"), chickencross: svg("heart"),
      dragontower: svg("safe"), hilo: svg("chevronDown"), roulette: svg("rotate"), flip: svg("coin"),
      mines: svg("grid"), aviamaster: svg("bolt"),
    })[art] || svg("spark");
  }

  function originalsList() {
    const catalog = Array.isArray(window.GAME_CATALOG) ? window.GAME_CATALOG : [];
    if (catalog.length) return catalog;
    // fallback if a page hasn't loaded games.js
    return [{ id: "limbo", name: "Limbo", available: true }];
  }

  function sidebarHTML(activeTab) {
    const collapsed = isSidebarCollapsed();
    const player = getPlayerProfile();
    const navItems = [
      { id: "home", icon: "home", label: "Home", href: "./index.html" },
      { id: "favorites", icon: "heart", label: "Favorites", href: "./index.html?tab=Games&filter=favorites", attr: "data-shell-favorites" },
      { id: "recent", icon: "clock", label: "Recently Played", attr: "data-shell-recent-played" },
      { id: "new", icon: "sparkles", label: "New Releases", attr: "data-shell-new-releases" },
      { id: "earn", icon: "bolt", label: "Incremental", href: "./earn.html" },
      { id: "gifts", icon: "gift", label: "Gifts", href: "./gifts.html" },
      { id: "blackmarket", icon: "gift", label: "Black Market", href: "./blackmarket.html" },
    ];
    const originals = originalsList();
    return `
      <aside class="rail ${collapsed ? "collapsed" : ""}">
        <div class="rail-top-row">
          <button class="rail-collapse-btn hover-tip" data-hover-tip="${collapsed ? "Expand sidebar" : "Collapse sidebar"}" data-shell-collapse aria-label="Collapse sidebar"><span style="display:inline-flex;transform:${collapsed ? "rotate(180deg)" : "none"};">${svg("chevronLeft")}</span></button>
        </div>
        <div class="rail-brand-row">
          <a class="brand" href="./index.html"><span class="brand-mark">${svg("spark")}</span><span class="brand-name">neon <span>jackpot</span></span></a>
        </div>
        <div class="rail-scroll">
          <button class="rail-case-cta hover-tip" data-hover-tip="Open the wager case" data-shell-case-cta>
            ${svg("gift")}<span class="rail-link-label">Wager Case</span>
            <span class="rail-case-badge" data-shell-case-badge>${raffleSpinsAvailable()}</span>
          </button>
          <button class="rail-player-card" data-shell-profile-open>
            <span class="rail-player-avatar" style="background:${player.avatarColor}; overflow:hidden;">${avatarContentHTML(player)}</span>
            <span class="rail-player-info">
              <span class="rail-player-name">${player.name}</span>
              <span class="rail-player-balance">${currencyCoinHTML()}<span data-shell-balance>${fmtMoney(getBalance())}</span></span>
            </span>
          </button>
          <nav class="rail-nav">
            ${navItems.map((t) => `<a class="rail-link ${t.href && t.href.startsWith("./index.html") && activeTab === "Lobby" && t.id === "home" ? "active" : ""}" ${t.attr || ""} href="${t.href || "#"}" title="${t.label}">${svg(t.icon)}<span class="rail-link-label">${t.label}</span></a>`).join("")}
          </nav>
          <div class="rail-section-label">Games</div>
          ${(() => {
            const dd = getRailDropdownState();
            const originalsOpen = dd.originals !== false; // default open
            const slotsOpen = !!dd.slots;
            return `
          <div class="rail-dropdown">
            <button class="rail-dropdown-toggle" data-originals-toggle>
              <span class="rail-dropdown-toggle-inner">${svg("grid")}<span class="rail-link-label">Originals</span></span>
              <span class="rail-link-label" data-originals-arrow style="display:inline-flex;transform:${originalsOpen ? "rotate(180deg)" : "none"};">${svg("chevronDown")}</span>
            </button>
            <div class="rail-dropdown-body ${originalsOpen ? "open" : ""}" data-originals-body>
              ${originals.map((g) => g.available
                ? `<a class="rail-sublink" href="./${g.id}.html"><span class="rail-sublink-icon">${gameSidebarIcon(g.art)}</span><span class="rail-link-label">${g.name}</span></a>`
                : `<span class="rail-sublink-soon rail-link-label"><span class="rail-sublink-icon">${gameSidebarIcon(g.art)}</span>${g.name} · Coming soon</span>`
              ).join("")}
            </div>
          </div>
          <div class="rail-dropdown">
            <button class="rail-dropdown-toggle" data-slots-toggle>
              <span class="rail-dropdown-toggle-inner">${svg("sparkles")}<span class="rail-link-label">Slots</span></span>
              <span class="rail-link-label" data-slots-arrow style="display:inline-flex;transform:${slotsOpen ? "rotate(180deg)" : "none"};">${svg("chevronDown")}</span>
            </button>
            <div class="rail-dropdown-body ${slotsOpen ? "open" : ""}" data-slots-body>
              ${(Array.isArray(window.SLOT_CATALOG) ? window.SLOT_CATALOG : []).map((g) => `<span class="rail-sublink-soon rail-link-label"><span class="rail-sublink-icon">${gameSidebarIcon(g.art)}</span>${g.name} · Coming soon</span>`).join("") || `<div class="rail-sublink-soon rail-link-label">Coming soon</div>`}
            </div>
          </div>`;
          })()}
          <div class="rail-divider"></div>
        </div>
        <div class="rail-footer">
          <button class="rail-settings-btn hover-tip" data-hover-tip="Settings" data-shell-settings title="Settings" aria-label="Settings">${svg("settings")}<span class="rail-link-label">Settings</span></button>
        </div>
      </aside>`;
  }

  function topbarHTML() {
    const hasUnread = unreadNotificationCount() > 0;
    return `
      <header class="topbar">
        <div class="topbar-inner">
          <a class="brand" href="./index.html"><span class="brand-mark">${svg("spark")}</span><span class="brand-name">neon <span>jackpot</span></span></a>
          <div class="top-actions">
            <div class="action-box">
              <button class="icon-button" data-shell-search aria-label="Search">${svg("search")}</button>
            </div>
            <div class="action-box">
              <button class="icon-button" data-shell-rewards aria-label="Rewards">${svg("gift")}</button>
              <button class="icon-button" data-shell-notify aria-label="Notifications">${svg("bell")}${hasUnread ? '<span class="notif-dot"></span>' : ""}</button>
              <button class="avatar" data-shell-profile aria-label="Profile" style="background:${getPlayerProfile().avatarColor}; overflow:hidden;">${avatarContentHTML(getPlayerProfile())}</button>
            </div>
          </div>
        </div>
        <div class="top-center-fixed">
          ${isDeveloper() ? `<button class="icon-button dev-toggle-btn hover-tip" data-hover-tip="Developer tools" data-dev-toggle aria-label="Developer tools">${svg("wrench")}</button>` : ""}
          <div class="credit ${getActiveCurrency() === "reward" ? "reward-active" : ""}" data-currency-box>
            <button class="credit-arrow" data-shell-currency-toggle aria-label="Choose currency" title="Choose currency">${svg("chevronDown")}</button>
            <span data-shell-currency-icon>${currencyCoinHTML()}</span>
            <strong data-shell-balance>${fmtMoney(getBalance())}</strong>
            <button class="reset hover-tip" data-hover-tip="Earn money" data-shell-earn title="Earn money">${svg("bolt")}</button>
          </div>
          <button class="icon-button vault-btn hover-tip" data-hover-tip="Vault" data-shell-vault aria-label="Vault">${svg("safe")}</button>
        </div>
      </header>`;
  }

  // ===================== VAULT MODAL =====================
  function openVaultModal(initialTab = "deposit") {
    closeAllOverlays();
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-vault-overlay", "");
    wrap.innerHTML = `
      <div class="shell-modal-box">
        <div class="shell-modal-head">
          <h3>${svg("lock")} Vault</h3>
          <button class="shell-modal-close" data-close-vault aria-label="Close">${svg("x")}</button>
        </div>
        <div class="vault-tabs">
          <button class="vault-tab" data-vault-tab="deposit">Deposit</button>
          <button class="vault-tab" data-vault-tab="withdraw">Withdraw</button>
        </div>
        <p class="vault-blurb">The vault keeps your funds safe for later use.</p>
        <p class="vault-blurb" style="margin-top:-8px;">Only your cash balance can be vaulted — reward balance isn't eligible.</p>
        <div class="vault-balance-row"><span>${svg("safe")} Vault Balance</span><strong data-vault-balance>${fmtMoney(getVaultBalance())}</strong></div>
        <div class="vault-field-label">Amount</div>
        <div class="vault-input-row">
          <span class="prefix">$</span>
          <input type="text" inputmode="decimal" placeholder="0.00" data-vault-amount>
          <button class="max-btn" data-vault-max>Max</button>
        </div>
        <button class="vault-submit" data-vault-submit disabled>Deposit</button>
      </div>`;
    document.body.appendChild(wrap);

    let tab = initialTab;
    const amountInput = wrap.querySelector("[data-vault-amount]");
    const submitBtn = wrap.querySelector("[data-vault-submit]");
    const balanceEl = wrap.querySelector("[data-vault-balance]");

    function capFor() { return tab === "deposit" ? getCashBalance() : getVaultBalance(); }
    function refresh() {
      wrap.querySelectorAll("[data-vault-tab]").forEach((b) => b.classList.toggle("active", b.dataset.vaultTab === tab));
      submitBtn.textContent = tab === "deposit" ? "Deposit" : "Withdraw";
      submitBtn.classList.toggle("withdraw", tab === "withdraw");
      balanceEl.textContent = fmtMoney(getVaultBalance());
      const amt = parseFloat(amountInput.value);
      const cap = capFor();
      submitBtn.disabled = !(amt > 0 && amt <= cap + 0.001);
    }
    wrap.querySelectorAll("[data-vault-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.vaultTab; amountInput.value = ""; refresh(); });
    wrap.querySelector("[data-vault-max]").onclick = () => { amountInput.value = capFor().toFixed(2); refresh(); };
    amountInput.addEventListener("input", refresh);
    submitBtn.onclick = () => {
      const amt = Math.round(parseFloat(amountInput.value) * 100) / 100;
      if (!(amt > 0)) return;
      if (tab === "deposit") {
        const take = Math.min(amt, getCashBalance());
        addCashBalance(-take);
        setVaultBalance(getVaultBalance() + take);
        notify(`Deposited ${fmtMoney(take)} into your vault.`);
      } else {
        const take = Math.min(amt, getVaultBalance());
        setVaultBalance(getVaultBalance() - take);
        addCashBalance(take);
        notify(`Withdrew ${fmtMoney(take)} from your vault.`);
      }
      amountInput.value = "";
      refresh();
    };
    wrap.querySelector("[data-close-vault]").onclick = closeAllOverlays;
    // Vault intentionally does NOT close on outside click — only the X button closes it.
    refresh();
  }

  // ===================== EARN (CLICKER) MODAL =====================
  let earnTickTimer = null;
  function openEarnModal() {
    closeAllOverlays();
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay earn-modal";
    wrap.setAttribute("data-earn-overlay", "");
    wrap.innerHTML = `
      <div class="shell-modal-box">
        <div class="shell-modal-head">
          <h3>${svg("bolt")} Earn money</h3>
          <button class="shell-modal-close" data-close-earn aria-label="Close">${svg("x")}</button>
        </div>
        <div class="earn-tabs">
          <button class="earn-tab" data-earn-tab="click">Click</button>
          <button class="earn-tab" data-earn-tab="clicker">Clicker</button>
          <button class="earn-tab" data-earn-tab="automation">Automation</button>
        </div>
        <div class="earn-panel" data-earn-panel="click">
          <div class="earn-click-zone">
            <button class="earn-click-btn" data-earn-click>Tap to earn<small data-earn-click-value></small></button>
          </div>
          <div class="earn-passive-box">
            <div class="earn-passive-row"><span>Passive rate</span><strong data-earn-rate></strong></div>
            <div class="earn-passive-row"><span>Unclaimed</span><strong data-earn-pending></strong></div>
            <button class="earn-claim-btn" data-earn-claim>Claim earnings</button>
          </div>
        </div>
        <div class="earn-panel" data-earn-panel="clicker">
          <div class="earn-upgrades" data-earn-upgrades="clicker"></div>
        </div>
        <div class="earn-panel" data-earn-panel="automation">
          <div class="earn-upgrades" data-earn-upgrades="automation"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);

    let tab = "click";
    function upgradeRowHTML(u, state) {
      const lvl = state.levels[u.id] || 0;
      const maxed = earnUpgradeMaxed(u.id);
      const cost = earnUpgradeCost(u.id);
      const affordable = !maxed && cost != null && getBalance() >= cost;
      return `<div class="earn-upgrade ${maxed ? "maxed" : ""}">
        <div class="earn-upgrade-icon">${svg(u.icon)}</div>
        <div class="earn-upgrade-body"><strong>${u.name} ${lvl ? `· Lv ${lvl}${u.maxLevel ? `/${u.maxLevel}` : ""}` : ""}</strong><span>${u.desc}</span></div>
        <button class="earn-upgrade-buy" data-earn-buy="${u.id}" ${(affordable && !maxed) ? "" : "disabled"}>${maxed ? "MAX" : fmtMoney(cost)}</button>
      </div>`;
    }
    function paint() {
      const state = earnTick();
      wrap.querySelectorAll("[data-earn-tab]").forEach((b) => b.classList.toggle("active", b.dataset.earnTab === tab));
      wrap.querySelectorAll("[data-earn-panel]").forEach((p) => p.classList.toggle("active", p.dataset.earnPanel === tab));

      const clickVal = earnClickValue(state);
      wrap.querySelector("[data-earn-click-value]").textContent = "+" + fmtMoney(clickVal) + " / click";
      const rate = earnPassiveRate(state);
      wrap.querySelector("[data-earn-rate]").textContent = rate > 0 ? fmtMoney(rate) + "/sec" : "None yet";
      wrap.querySelector("[data-earn-pending]").textContent = fmtMoney(state.pendingPassive || 0);
      const claimBtn = wrap.querySelector("[data-earn-claim]");
      claimBtn.disabled = !((state.pendingPassive || 0) >= 0.01);

      ["clicker", "automation"].forEach((cat) => {
        const upgradesEl = wrap.querySelector(`[data-earn-upgrades="${cat}"]`);
        upgradesEl.innerHTML = EARN_UPGRADES.filter((u) => u.category === cat).map((u) => upgradeRowHTML(u, state)).join("");
        upgradesEl.querySelectorAll("[data-earn-buy]").forEach((b) => b.onclick = () => {
          if (earnBuyUpgrade(b.dataset.earnBuy)) { playChipSound("select"); paint(); }
        });
      });
    }

    wrap.querySelectorAll("[data-earn-tab]").forEach((b) => b.onclick = () => { tab = b.dataset.earnTab; paint(); });
    wrap.querySelector("[data-earn-click]").onclick = (e) => {
      const value = earnClick();
      const btn = e.currentTarget;
      if (!value) {
        // Rate-capped: give a subtle "too fast" cue instead of silently doing nothing.
        btn.classList.remove("earn-click-capped"); void btn.offsetWidth;
        btn.classList.add("earn-click-capped");
        return;
      }
      playChipSound("select");
      const float = document.createElement("span");
      float.className = "earn-float";
      float.textContent = "+" + fmtMoney(value);
      const rect = btn.getBoundingClientRect();
      float.style.left = (e.clientX - rect.left) + "px";
      float.style.top = (e.clientY - rect.top) + "px";
      btn.style.position = "relative";
      btn.appendChild(float);
      setTimeout(() => float.remove(), 820);
      // Deliberately do NOT call the full paint() here — see earn.html for the full explanation.
      // paint() calls earnTick(), which accrues passive earnings based on elapsed real time;
      // that must only ever run on the 1s interval, never as a side effect of a click, or the
      // "Unclaimed" passive number visibly (and actually) jumps every time you click.
      const small = wrap.querySelector("[data-earn-click-value]");
      if (small) small.textContent = "+" + fmtMoney(earnClickValue(getEarnState())) + " / click";
    };
    wrap.querySelector("[data-earn-claim]").onclick = () => {
      const amount = earnClaimPassive();
      if (amount > 0) {
        notify(`Claimed ${fmtMoney(amount)} in passive earnings.`);
        addNotification({ type: "earnings", title: "Earnings claimed", detail: `+${fmtMoney(amount)} added to your balance.` });
        refreshNotifDot();
      }
      paint();
    };
    wrap.querySelector("[data-close-earn]").onclick = closeAllOverlays;
    bindOverlayOutsideClose(wrap);

    paint();
    earnTickTimer = setInterval(paint, 1000);
  }

  // ===================== SEARCH MODAL =====================
  function openSearchModal() {
    closeAllOverlays();
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay top";
    wrap.setAttribute("data-search-overlay", "");
    wrap.innerHTML = `
      <div class="shell-modal-box wide">
        <div class="shell-modal-head">
          <h3>${svg("search")} Search</h3>
          <button class="shell-modal-close" data-close-search aria-label="Close">${svg("x")}</button>
        </div>
        <div class="search-input-row">${svg("search")}<input type="text" placeholder="Search games" data-search-input autofocus></div>
        <div data-search-body></div>
      </div>`;
    document.body.appendChild(wrap);

    const catalog = Array.isArray(window.GAME_CATALOG) ? window.GAME_CATALOG : [];
    const input = wrap.querySelector("[data-search-input]");
    const body = wrap.querySelector("[data-search-body]");

    function gameCardMini(game) {
      const inner = gameArtInner(game);
      return `<article class="game ${game.available ? "" : "unavailable"}" data-search-play="${game.id}" style="cursor:${game.available ? "pointer" : "default"};">
        <div class="game-art ${game.art}">
          ${inner}
          ${game.available ? "" : `<span class="unavailable-badge">Unavailable</span>`}
        </div>
      </article>`;
    }

    function paint() {
      const q = input.value.trim().toLowerCase();
      if (!q) {
        const recent = getRecentSearches();
        body.innerHTML = `
          <div class="search-section-label">Recent Searches</div>
          <div class="search-recent">${recent.length ? recent.map((t) => `<span class="search-chip" data-recent-term="${t}">${t}<button data-remove-recent="${t}" aria-label="Remove">${svg("x")}</button></span>`).join("") : `<span class="search-empty" style="padding:4px 0;">No recent searches</span>`}</div>`;
        body.querySelectorAll("[data-recent-term]").forEach((chip) => chip.onclick = (e) => {
          if (e.target.closest("[data-remove-recent]")) return;
          input.value = chip.getAttribute("data-recent-term");
          paint();
        });
        body.querySelectorAll("[data-remove-recent]").forEach((btn) => btn.onclick = (e) => {
          e.stopPropagation();
          removeRecentSearch(btn.dataset.removeRecent);
          paint();
        });
        return;
      }
      const results = catalog.filter((g) => g.name.toLowerCase().includes(q) || g.description.toLowerCase().includes(q));
      body.innerHTML = `
        <div class="search-divider"></div>
        <div class="search-section-label">Results for "${input.value.trim()}"</div>
        ${results.length ? `<div class="search-results-grid">${results.map(gameCardMini).join("")}</div>` : `<div class="search-empty">No games found</div>`}`;
      body.querySelectorAll("[data-search-play]").forEach((card) => card.onclick = () => {
        const id = card.dataset.searchPlay;
        const game = catalog.find((g) => g.id === id);
        if (game && game.available) window.location.href = `./${id}.html`;
      });
    }

    let searchDebounce = null;
    input.addEventListener("input", () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(paint, 120);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value.trim()) { addRecentSearch(input.value.trim()); paint(); }
    });
    input.addEventListener("blur", () => { if (input.value.trim()) addRecentSearch(input.value.trim()); });

    wrap.querySelector("[data-close-search]").onclick = closeAllOverlays;
    bindOverlayOutsideClose(wrap);
    paint();
    requestAnimationFrame(() => input.focus());
  }

  // ===================== NOTIFICATIONS DROPDOWN =====================
  function refreshNotifDot() {
    const dot = document.querySelector("[data-shell-notify] .notif-dot");
    const has = unreadNotificationCount() > 0;
    const btn = document.querySelector("[data-shell-notify]");
    if (!btn) return;
    if (has && !dot) { const s = document.createElement("span"); s.className = "notif-dot"; btn.appendChild(s); }
    if (!has && dot) dot.remove();
  }

  function openNotifDropdown(anchorBtn) {
    closeAllOverlays();
    const list = getNotifications();
    const dd = document.createElement("div");
    dd.className = "shell-dropdown right";
    dd.setAttribute("data-notif-dropdown", "");
    dd.innerHTML = `
      <div class="notif-head"><strong>Notifications</strong><span>${list.length} total</span></div>
      <div class="notif-list">
        ${list.length ? list.map((n) => `
          <div class="notif-item">
            <div class="notif-icon ${n.type === "reward" ? "reward" : ""}">${svg(n.type === "reward" ? "gift" : "bolt")}</div>
            <div class="notif-item-body"><p>${n.title}${n.detail ? ` — ${n.detail}` : ""}</p><span>${timeAgo(n.time)}</span></div>
          </div>`).join("") : `<div class="notif-empty">You're all caught up.</div>`}
      </div>`;
    anchorBtn.parentElement.style.position = anchorBtn.parentElement.style.position || "relative";
    anchorBtn.insertAdjacentElement("afterend", dd);
    dd.style.position = "absolute";
    markNotificationsRead();
    refreshNotifDot();

    setTimeout(() => document.addEventListener("click", outsideCloser), 0);
    function outsideCloser(e) {
      if (!dd.contains(e.target) && e.target !== anchorBtn) { dd.remove(); document.removeEventListener("click", outsideCloser); }
    }
  }

  // ===================== PROFILE DROPDOWN =====================
  function openProfileDropdown(anchorBtn) {
    closeAllOverlays();
    const dd = document.createElement("div");
    dd.className = "shell-dropdown right";
    dd.setAttribute("data-profile-dropdown", "");
    dd.innerHTML = `
      <div class="profile-dropdown">
        <button class="profile-link" data-profile-item="profile">${svg("user")} Profile</button>
        <button class="profile-link" data-profile-item="bets">${svg("list")} Bets</button>
        <button class="profile-link" data-profile-item="vault">${svg("lock")} Vault</button>
        <button class="profile-link" data-profile-item="rewards">${svg("gift")} Rewards</button>
        <button class="profile-link" data-profile-item="gifts">${svg("bolt")} Gifts</button>
        <button class="profile-link" data-profile-item="switch-account">${svg("user")} Switch Accounts</button>
        <button class="profile-link" data-profile-item="settings">${svg("settings")} Settings</button>
      </div>`;
    anchorBtn.insertAdjacentElement("afterend", dd);
    dd.style.position = "absolute";

    dd.querySelector('[data-profile-item="profile"]').onclick = () => { dd.remove(); openProfileModal(); };
    dd.querySelector('[data-profile-item="bets"]').onclick = () => { dd.remove(); window.location.href = "./bets.html"; };
    dd.querySelector('[data-profile-item="vault"]').onclick = () => { dd.remove(); openVaultModal(); };
    dd.querySelector('[data-profile-item="rewards"]').onclick = () => { dd.remove(); window.location.href = "./rewards.html"; };
    dd.querySelector('[data-profile-item="gifts"]').onclick = () => { dd.remove(); window.location.href = "./gifts.html"; };
    dd.querySelector('[data-profile-item="switch-account"]').onclick = () => { dd.remove(); switchAccount(); };
    dd.querySelector('[data-profile-item="settings"]').onclick = () => { dd.remove(); openSettingsModal(); };

    setTimeout(() => document.addEventListener("click", outsideCloser), 0);
    function outsideCloser(e) {
      if (!dd.contains(e.target) && e.target !== anchorBtn) { dd.remove(); document.removeEventListener("click", outsideCloser); }
    }
  }

  // ===================== DEVELOPER PANEL (profile modal add-on) =====================
  function devUnlockHTML() {
    return `<div class="dev-unlock-section">
      <button class="dev-unlock-toggle" data-dev-unlock-toggle>${svg("lock")} Have a developer code?</button>
      <div class="dev-unlock-box" data-dev-unlock-box style="display:none;">
        <div class="vault-input-row"><input type="text" placeholder="Enter secret code" data-dev-code-input autocomplete="off"></div>
        <button class="vault-submit" data-dev-code-submit>Unlock</button>
        <div class="dev-unlock-error" data-dev-unlock-error style="display:none;">Incorrect code.</div>
      </div>
    </div>`;
  }

  function bindDevPanel(wrap, rerender) {
    const unlockToggle = wrap.querySelector("[data-dev-unlock-toggle]");
    const unlockBox = wrap.querySelector("[data-dev-unlock-box]");
    if (unlockToggle && unlockBox) unlockToggle.onclick = () => {
      unlockBox.style.display = unlockBox.style.display === "none" ? "block" : "none";
    };
    const unlockSubmit = wrap.querySelector("[data-dev-code-submit]");
    if (unlockSubmit) unlockSubmit.onclick = () => {
      const val = wrap.querySelector("[data-dev-code-input]").value;
      const err = wrap.querySelector("[data-dev-unlock-error]");
      if (tryUnlockDeveloper(val)) {
        notify("Developer mode unlocked.");
        rerender();
      } else if (err) {
        err.style.display = "block";
      }
    };
    const enabledToggle = wrap.querySelector("[data-dev-enabled-toggle]");
    if (enabledToggle) enabledToggle.onchange = () => {
      const on = setDeveloperEnabled(enabledToggle.checked);
      notify(on ? "Developer tools enabled." : "Developer tools disabled.");
      persistActiveAccount();
      pushLiveAccountStateNow();
      renderDevFloatingPanel();
      rerender();
    };
  }

  // ===================== FLOATING DEVELOPER TOOLS PANEL =====================
  // Opened via the wrench icon in the top bar (only shown once isDeveloper() is true).
  // Unlike other overlays, this one is NOT closed by an outside click — only its own X button —
  // and both its open/closed state and its screen position persist across page navigations
  // via localStorage, the same way the sidebar-collapsed state does.
  const DEV_PANEL_OPEN_KEY = "nj_dev_panel_open";
  const DEV_PANEL_POS_KEY = "nj_dev_panel_pos";
  function isDevPanelOpen() { return localStorage.getItem(DEV_PANEL_OPEN_KEY) === "1"; }
  function setDevPanelOpen(open) { localStorage.setItem(DEV_PANEL_OPEN_KEY, open ? "1" : "0"); }
  function getDevPanelPos() {
    try { return JSON.parse(localStorage.getItem(DEV_PANEL_POS_KEY)) || null; } catch { return null; }
  }
  function setDevPanelPos(pos) { localStorage.setItem(DEV_PANEL_POS_KEY, JSON.stringify(pos)); }

  function devFloatingPanelHTML() {
    const pos = getDevPanelPos();
    return `<div class="dev-float-panel" data-dev-float-panel style="${pos ? `left:${pos.left}px; top:${pos.top}px;` : "right:24px; top:90px;"}">
      <div class="dev-float-head" data-dev-float-drag-handle>
        <span>${svg("wrench")} Developer Tools</span>
        <button class="dev-float-close" data-dev-float-close aria-label="Close">${svg("x")}</button>
      </div>
      <div class="dev-row">
        <div class="dev-row-controls">
          <label class="dev-enable-toggle" style="margin-top:5px;">
            <input type="checkbox" data-dev-appear-offline ${isAppearOffline() ? "checked" : ""}>
            <span>Off</span>
          </label>
        </div>
      <div class="dev-float-body">
        <div class="dev-row">
          <div class="dev-row-label">Set balance</div>
          <div class="dev-row-controls">
            <input type="number" min="0" step="1" placeholder="Amount" data-dev-balance-input>
            <button class="dev-btn" data-dev-set-balance>Set</button>
          </div>
        </div>

        <div class="dev-row">
          <div class="dev-row-label">Rank</div>
          <div class="dev-row-controls">
            <button class="dev-btn" data-dev-max-rank>Max rank</button>
            <select data-dev-rank-select>
              ${Array.from({ length: RANK_TOTAL_TIERS + 1 }, (_, t) => `<option value="${t}">${t === 0 ? "Unranked" : rankTierLabel(t)}</option>`).join("")}
            </select>
            <button class="dev-btn" data-dev-set-rank>Set</button>
          </div>
        </div>

        <div class="dev-row">
          <div class="dev-row-label">Incremental game</div>
          <div class="dev-row-controls">
            <button class="dev-btn" data-dev-max-earn>Max all upgrades</button>
            <button class="dev-btn" data-dev-reset-earn>Reset upgrades to 0</button>
          </div>
        </div>

        <div class="dev-row">
          <div class="dev-row-label">Wager cases</div>
          <div class="dev-row-controls">
            <input type="number" min="0" step="1" placeholder="Count" data-dev-cases-input>
            <button class="dev-btn" data-dev-grant-cases>Grant to me</button>
          </div>
        </div>

        <div class="dev-row">
          <div class="dev-row-label">Wager case upgrades</div>
          <div class="dev-row">
          <div class="dev-row-controls"><button class="dev-btn" data-dev-reset-case-upgrades>Reset Luck/Speed/Multiplier to 0</button></div>
        </div>

        <div class="dev-panel-divider"></div>
        <div class="dev-panel-head small">${svg("bolt")} Live Update</div>
        ${devLiveUpdateHTML()}

        <div class="dev-panel-divider"></div>
        <button class="dev-btn dev-revert-btn" data-dev-revert ${hasDevSnapshot() ? "" : "disabled"}>${svg("rotate")} Revert changes</button>
        <div class="dev-revert-note">${hasDevSnapshot() ? "Restores your account to how it was right before you started using developer tools." : "No changes to revert yet — use a tool above first."}</div>
      </div>
    </div>`;
  }

  // Reads live state from Chat.getVersionInfo() (if chat.js is loaded and connected) so the
  // inputs prefill with whatever's currently published, rather than opening blank every time.
  function devLiveUpdateHTML() {
    const hasChat = typeof window.Chat !== "undefined" && typeof window.Chat.getVersionInfo === "function";
    if (!hasChat) {
      return `<div class="dev-revert-note">Chat.js isn't loaded on this page, so Live Update controls aren't available here.</div>`;
    }
    const info = window.Chat.getVersionInfo();
    const published = info.latest || "";
    const matches = published && String(published) === String(info.current);
    return `
      <div class="dev-row">
        <div class="dev-row-label">Local version (this build): <strong style="color:#c98bff;">${info.current}</strong></div>
        <div class="dev-row-label" style="margin-top:2px;">Currently published: <strong style="color:${published ? (matches ? "#5cffe7" : "#ff9fb8") : "#6c7488"};">${published ? published : "none"}</strong>${published && !matches ? " (players are locked out)" : ""}</div>
      </div>
      <div class="dev-row">
        <div class="dev-row-label">New version number</div>
        <div class="dev-row-controls">
          <input type="text" placeholder="e.g. 2" value="${info.current}" data-dev-version-input>
        </div>
      </div>
      <div class="dev-row">
        <div class="dev-row-label">Download link (setup.exe host)</div>
        <div class="dev-row-controls">
          <input type="text" placeholder="https://..." value="${info.downloadUrl || ""}" data-dev-download-input>
        </div>
      </div>
      <div class="dev-row">
        <div class="dev-row-controls">
          <button class="dev-btn" data-dev-publish-update style="flex:1;">${svg("bolt")} Publish update — lock out old versions</button>
        </div>
      </div>
      <div class="dev-revert-note"></div>`;
  }

  let devPanelDrag = null;
  function renderDevFloatingPanel() {
    document.querySelector("[data-dev-float-panel]")?.remove();
    if (!isDeveloper() || !isDevPanelOpen()) return;
    document.body.insertAdjacentHTML("beforeend", devFloatingPanelHTML());
    bindDevFloatingPanel();
  }

  function bindDevFloatingPanel() {
    const panel = document.querySelector("[data-dev-float-panel]");
    if (!panel) return;

    panel.querySelector("[data-dev-float-close]").onclick = () => {
      setDevPanelOpen(false);
      panel.remove();
    };

    panel.querySelector("[data-dev-appear-offline]")?.addEventListener("change", (e) => {
      setAppearOffline(e.target.checked);
      notify(e.target.checked ? "You're now hidden from presence." : "You're visible in presence again.");
    });

    panel.querySelector("[data-dev-set-balance]")?.addEventListener("click", () => {
      const v = parseFloat(panel.querySelector("[data-dev-balance-input]").value);
      if (isNaN(v)) return;
      devSetBalance(v);
      notify(`Balance set to ${fmtMoney(v)}.`);
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-max-rank]")?.addEventListener("click", () => {
      devMaxRank();
      notify("Rank maxed out.");
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-set-rank]")?.addEventListener("click", () => {
      const t = parseInt(panel.querySelector("[data-dev-rank-select]").value, 10);
      devSetRank(t);
      notify(`Rank set to ${t === 0 ? "Unranked" : rankTierLabel(t)}.`);
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-max-earn]")?.addEventListener("click", () => {
      devMaxIncremental();
      notify("Incremental game maxed out.");
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-reset-earn]")?.addEventListener("click", () => {
      devResetIncremental();
      notify("Incremental upgrades reset to 0.");
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-grant-cases]")?.addEventListener("click", () => {
      const n = parseInt(panel.querySelector("[data-dev-cases-input]").value, 10);
      if (!n || n <= 0) return;
      devGrantCases(n);
      notify(`Granted ${n} wager case${n === 1 ? "" : "s"}.`);
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-reset-case-upgrades]")?.addEventListener("click", () => {
      devResetCaseUpgrades();
      notify("Wager case upgrades reset to 0.");
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-publish-update]")?.addEventListener("click", () => {
      if (typeof window.Chat === "undefined" || typeof window.Chat.publishUpdate !== "function") {
        notify("Chat.js isn't available on this page.");
        return;
      }
      const version = (panel.querySelector("[data-dev-version-input]")?.value || "").trim();
      const downloadUrl = (panel.querySelector("[data-dev-download-input]")?.value || "").trim();
      if (!version) { notify("Enter a version number first."); return; }
      window.Chat.publishUpdate(version, downloadUrl);
      notify(`Published v${version} — players on older versions are now locked out until they update.`);
      renderDevFloatingPanel();
    });
    panel.querySelector("[data-dev-revert]")?.addEventListener("click", () => {
      if (devRevertChanges()) {
        notify("Reverted to your account state from before developer changes.");
        renderDevFloatingPanel();
      }
    });

    const dragHandle = panel.querySelector("[data-dev-float-drag-handle]");
    dragHandle.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-dev-float-close]")) return;
      const rect = panel.getBoundingClientRect();
      devPanelDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
      panel.classList.add("dragging");
      e.preventDefault();
    });
  }

  // one shared mousemove/mouseup pair, safe to attach once at module load — only acts while
  // devPanelDrag is set by the handler above.
  window.addEventListener("mousemove", (e) => {
    if (!devPanelDrag) return;
    const panel = document.querySelector("[data-dev-float-panel]");
    if (!panel) return;
    const panelW = panel.offsetWidth, panelH = panel.offsetHeight;
    const left = Math.max(8, Math.min(e.clientX - devPanelDrag.offsetX, window.innerWidth - panelW - 8));
    const top = Math.max(8, Math.min(e.clientY - devPanelDrag.offsetY, window.innerHeight - panelH - 8));
    panel.style.left = left + "px";
    panel.style.top = top + "px";
    panel.style.right = "auto";
    setDevPanelPos({ left, top });
  });
  window.addEventListener("mouseup", () => {
    if (!devPanelDrag) return;
    devPanelDrag = null;
    document.querySelector("[data-dev-float-panel]")?.classList.remove("dragging");
  });

  // ===================== PROFILE MODAL (centered, blurred backdrop) =====================
  function openProfileModal() {
    closeAllOverlays();
    const player = getPlayerProfile();
    const stats = rankStats();
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-profile-modal-overlay", "");
    wrap.innerHTML = `
      <div class="shell-modal-box profile-modal-box">
        <div class="shell-modal-head">
          <h3>Profile</h3>
          <button class="shell-modal-close" data-close-profile-modal aria-label="Close">${svg("x")}</button>
        </div>
        <div class="profile-id-row"><span>ID:</span><strong>${player.id}</strong><button class="id-copy-btn hover-tip" data-hover-tip="Copy" data-copy-id aria-label="Copy ID">${svg("grid")}</button></div>
        <button class="profile-reset-btn" data-export-card style="background:rgba(92,255,231,.08);border:1px solid rgba(92,255,231,.3);color:#5cffe7;margin-top:12px;margin-bottom:12px;">${svg("gift")} Export Profile Card</button>
        <div class="profile-name-row">
          <div class="profile-avatar-lg" style="background:${player.avatarColor}; overflow:hidden;">${avatarContentHTML(player)}</div>
          <div>
            <div class="profile-name">${player.name}</div>
            <div class="profile-member">Member since ${fmtMemberSince(player.memberSince)}</div>
          </div>
          <div class="profile-remaining"><strong data-shell-balance-modal>${fmtMoney(getBalance())}</strong><span>remaining</span></div>
        </div>
        <div class="progress-track profile-progress-track"><div class="progress-fill" style="width:${stats.pct}%"></div></div>
        <div class="progress-ranks">
          <span class="rank-chip active" style="${stats.tier > 0 ? rankTextStyle(stats.track) : ""}">${svg("safe")} ${stats.label.toUpperCase()}</span>
          <span class="rank-chip">${svg("spark")} ${stats.isMax ? "MAX RANK" : stats.nextLabel.toUpperCase()}</span>
        </div>
        <div class="profile-stat-grid">
          <div class="profile-stat-box"><div class="profile-stat-icon">${svg("coin")}</div><div><small>Total Bets</small><strong>${stats.totalBets.toLocaleString()}</strong></div></div>
          <div class="profile-stat-box"><div class="profile-stat-icon">${svg("wallet")}</div><div><small>Total Wagered</small><strong>${fmtMoney(stats.totalWagered)}</strong></div></div>
        </div>
        ${isDeveloperUnlocked() ? `<div class="dev-unlock-section">
            <div class="dev-unlocked-note">${svg("wrench")} Developer access unlocked on this account.${isDeveloperEnabled() ? " Use the wrench icon in the top bar to open your tools." : " Tools are currently turned off."}</div>
            <label class="dev-enable-toggle">
              <input type="checkbox" data-dev-enabled-toggle ${isDeveloperEnabled() ? "checked" : ""}>
              <span>Enable developer tools</span>
            </label>
          </div>` : devUnlockHTML()}
        <button class="profile-reset-btn" data-reset-progress>${svg("rotate")} Reset account progress</button>
      </div>`;
    document.body.appendChild(wrap);
    bindDevPanel(wrap, () => { closeAllOverlays(); openProfileModal(); });
    wrap.querySelector("[data-close-profile-modal]").onclick = closeAllOverlays;
    bindOverlayOutsideClose(wrap);
    wrap.querySelector("[data-export-card]").onclick = () => exportProfileCardImage(player, stats);
    wrap.querySelector("[data-copy-id]").onclick = () => {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(player.id).catch(() => {});
      notify("Player ID copied.");
    };
    wrap.querySelector("[data-reset-progress]").onclick = () => {
      const btn = wrap.querySelector("[data-reset-progress]");
      if (!btn.classList.contains("confirming")) {
        btn.classList.add("confirming");
        btn.innerHTML = `${svg("x")} Click again to confirm — this can't be undone`;
        setTimeout(() => {
          if (btn.classList.contains("confirming")) {
            btn.classList.remove("confirming");
            btn.innerHTML = `${svg("rotate")} Reset account progress`;
          }
        }, 4000);
        return;
      }
      resetAllProgress();
      notify("Account progress has been reset.");
      closeAllOverlays();
    };
    const balEl = wrap.querySelector("[data-shell-balance-modal]");
    const onBal = (e) => { if (balEl) balEl.textContent = fmtMoney(e.detail); };
    document.addEventListener("nj:balance", onBal);
    wrap.addEventListener("DOMNodeRemoved", () => document.removeEventListener("nj:balance", onBal));
  }

  function exportProfileCardImage(player, stats) {
    const W = 900, H = 500;
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#12152f");
    grad.addColorStop(1, "#1a1e3d");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(92,255,231,.35)";
    ctx.lineWidth = 3;
    ctx.strokeRect(6, 6, W - 12, H - 12);

    ctx.fillStyle = "#5cffe7";
    ctx.font = "800 22px sans-serif";
    ctx.fillText("NEON JACKPOT", 40, 60);

    function drawCardAndFinish(avatarImg) {
      if (avatarImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(110, 160, 56, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(avatarImg, 54, 104, 112, 112);
        ctx.restore();
      } else {
        ctx.fillStyle = player.avatarColor || "#5cffe7";
        ctx.beginPath(); ctx.arc(110, 160, 56, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = "#04140f";
        ctx.font = "800 32px monospace";
        ctx.textAlign = "center";
        ctx.fillText(avatarInitials(player.name), 110, 172);
        ctx.textAlign = "left";
      }

      ctx.fillStyle = "#eef3f8";
      ctx.font = "800 30px sans-serif";
      ctx.fillText(player.name, 200, 150);

      const rankColor = rankColorFor(stats.track).color;
      ctx.fillStyle = rankColor;
      ctx.font = "800 16px monospace";
      ctx.fillText(stats.label.toUpperCase(), 200, 182);

      const statBoxes = [
        { label: "TOTAL BETS", value: stats.totalBets.toLocaleString() },
        { label: "TOTAL WAGERED", value: fmtMoney(stats.totalWagered) },
        { label: "MEMBER SINCE", value: fmtMemberSince(player.memberSince) },
      ];
      let x = 40;
      statBoxes.forEach((s) => {
        ctx.fillStyle = "rgba(255,255,255,.05)";
        ctx.fillRect(x, 260, 260, 90);
        ctx.strokeStyle = "rgba(150,166,207,.2)";
        ctx.strokeRect(x, 260, 260, 90);
        ctx.fillStyle = "#69758c";
        ctx.font = "700 11px monospace";
        ctx.fillText(s.label, x + 16, 290);
        ctx.fillStyle = "#eef3f8";
        ctx.font = "800 20px monospace";
        ctx.fillText(s.value, x + 16, 322);
        x += 280;
      });

      ctx.fillStyle = "#4c5468";
      ctx.font = "600 11px sans-serif";
      ctx.fillText("neonjackpot — fictional arcade demo, no cash value", 40, 460);

      const url = canvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `${player.name.replace(/\s+/g, "_")}_profile_card.png`;
      a.click();
      notify("Profile card exported.");
    }

    const imgSrc = getAvatarImage();
    if (imgSrc) {
      const img = new Image();
      img.onload = () => drawCardAndFinish(img);
      img.onerror = () => drawCardAndFinish(null);
      img.src = imgSrc;
    } else {
      drawCardAndFinish(null);
    }
  }
  // ===================== SETTINGS MODAL =====================
  // Two screens sharing one overlay: "main" (Disable Animations + Logout + entry point into
  // Account Personalization) and "personalization" (display name / color / emoji / uploaded
  // profile picture — everything that used to live directly on the main Settings page).
  function openSettingsModal(startScreen) {
    closeAllOverlays();
    const colors = ["#5cffe7", "#3aa0ff", "#ff5c9f", "#ffcf7d", "#c98bff", "#ff6e8f"];
    let screen = startScreen === "personalization" ? "personalization" : startScreen === "password" ? "password" : "main";

    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-settings-overlay", "");
    document.body.appendChild(wrap);
    bindOverlayOutsideClose(wrap);

    function render() {
      wrap.innerHTML = screen === "personalization" ? personalizationHTML() : screen === "password" ? passwordHTML() : screen === "sync" ? syncHTML() : mainHTML();
      wrap.querySelector("[data-close-settings]").onclick = closeAllOverlays;
      if (screen === "main") bindMain();
      else if (screen === "password") bindPassword();
      else if (screen === "sync") bindSync();
      else bindPersonalization();
    }

    function mainHTML() {
      const animOff = isAnimationsDisabled();
      return `
      <div class="shell-modal-box">
        <div class="shell-modal-head">
          <h3>${svg("settings")} Settings</h3>
          <button class="shell-modal-close" data-close-settings aria-label="Close">${svg("x")}</button>
        </div>
        <button class="settings-nav-row" data-open-personalization>
          <span class="settings-nav-row-label">${svg("user")} Account Personalization</span>
          <span class="settings-nav-row-sub">Name, color, emoji, profile picture</span>
        </button>
        <button class="settings-nav-row" data-open-password>
          <span class="settings-nav-row-label">${svg("lock")} Change Password</span>
          <span class="settings-nav-row-sub">Update the password for this account</span>
        </button>
        <button class="settings-nav-row" data-open-sync>
          <span class="settings-nav-row-label">${svg("lock")} Account Sync Code</span>
          <span class="settings-nav-row-sub">Back up or move your account to another device</span>
        </button>
        <div class="popover-row settings-toggle-row">
          <span>Disable Animations</span>
          <button class="switch ${animOff ? "on" : ""}" data-toggle-animations aria-label="Disable animations"></button>
        </div>
        <button class="profile-reset-btn logout-btn" data-do-logout>${svg("lock")} Log out</button>
      </div>`;
    }

    function passwordHTML() {
      return `
      <div class="shell-modal-box">
        <div class="shell-modal-head">
          <button class="shell-modal-close" data-back-to-main aria-label="Back">${svg("chevronLeft")}</button>
          <h3>Change Password</h3>
          <button class="shell-modal-close" data-close-settings aria-label="Close">${svg("x")}</button>
        </div>
        <div class="vault-field-label">Current password</div>
        <div class="vault-input-row"><input type="password" placeholder="Current password" data-pw-current autocomplete="off"></div>
        <div class="vault-field-label">New password</div>
        <div class="vault-input-row"><input type="password" placeholder="New password" data-pw-new autocomplete="off"></div>
        <div class="vault-field-label">Retype new password</div>
        <div class="vault-input-row"><input type="password" placeholder="Retype new password" data-pw-confirm autocomplete="off"></div>
        <div class="gift-error" data-pw-error style="display:none;"></div>
        <button class="vault-submit" data-pw-save>Update password</button>
      </div>`;
    }
    function syncHTML() {
      return `
      <div class="shell-modal-box">
        <div class="shell-modal-head">
          <button class="shell-modal-close" data-back-to-main aria-label="Back">${svg("chevronLeft")}</button>
          <h3>Account Sync Code</h3>
          <button class="shell-modal-close" data-close-settings aria-label="Close">${svg("x")}</button>
        </div>
        <p class="vault-blurb">Copy this code and paste it into Neon Jackpot on any other device to load this exact account.</p>
        <div class="sync-code-row">
          <div class="sync-code-blur" data-sync-code-wrap>
            <span class="sync-code-text" data-sync-code>${exportAccountCode()}</span>
            <div class="sync-code-veil" data-sync-veil>${svg("lock")} Click to reveal</div>
          </div>
          <button class="id-copy-btn hover-tip" data-hover-tip="Copy code" data-copy-sync aria-label="Copy sync code">${svg("grid")}</button>
        </div>
      </div>`;
    }
    function personalizationHTML() {
      const player = getPlayerProfile();
      const img = getAvatarImage();
      return `
      <div class="shell-modal-box">
        <div class="shell-modal-head">
          <button class="shell-modal-close" data-back-to-main aria-label="Back">${svg("chevronLeft")}</button>
          <h3>Account Personalization</h3>
          <button class="shell-modal-close" data-close-settings aria-label="Close">${svg("x")}</button>
        </div>
        <div class="settings-avatar-row">
          <div class="avatar-edit-wrap">
            <div class="profile-avatar-lg" data-settings-avatar-preview style="background:${player.avatarColor}; overflow:hidden;">${img ? `<img src="${img}" alt="" style="width:100%;height:100%;object-fit:cover;" />` : (player.avatarEmoji || avatarInitials(player.name))}</div>
            <button class="avatar-edit-pencil hover-tip" data-hover-tip="Upload photo" data-avatar-upload-btn aria-label="Upload profile picture">${svg("edit")}</button>
            <input type="file" accept="image/png,image/jpeg" data-avatar-file-input style="display:none;">
          </div>
          <div class="settings-swatches-col">
            <div class="settings-swatches">${colors.map((c) => `<button class="settings-swatch ${c === player.avatarColor ? "active" : ""}" data-avatar-color="${c}" style="background:${c};" aria-label="Choose color"></button>`).join("")}</div>
            ${img ? `<button class="settings-remove-photo" data-remove-photo>${svg("x")} Remove photo, use emoji</button>` : `<span class="settings-swatch-hint">Color shows behind your emoji/initials</span>`}
          </div>
        </div>
        <div class="vault-field-label">Username / Display name</div>
        <div class="vault-input-row"><input type="text" maxlength="18" value="${player.name}" data-settings-name placeholder="Your username"></div>
        <div class="vault-field-label">Password (required to change username)</div>
        <div class="vault-input-row"><input type="password" placeholder="Enter your password" data-settings-password autocomplete="off"></div>
        <div class="gift-error" data-username-error style="display:none;"></div>
        <div class="vault-field-label">Avatar emoji (optional)</div>
        <div class="vault-input-row"><input type="text" maxlength="2" value="${player.avatarEmoji || ""}" data-settings-emoji placeholder="e.g. 🎲"></div>
        <button class="vault-submit" data-settings-save>Save changes</button>
      </div>`;
    }

    function bindMain() {
      wrap.querySelector("[data-open-personalization]").onclick = () => { screen = "personalization"; render(); };
      wrap.querySelector("[data-open-password]").onclick = () => { screen = "password"; render(); };
      wrap.querySelector("[data-open-sync]").onclick = () => { screen = "sync"; render(); };
      wrap.querySelector("[data-toggle-animations]").onclick = (e) => {
        const next = setAnimationsDisabled(!isAnimationsDisabled());
        e.currentTarget.classList.toggle("on", next);
        notify(next ? "Animations disabled." : "Animations enabled.");
      };
      wrap.querySelector("[data-do-logout]").onclick = () => {
        const btn = wrap.querySelector("[data-do-logout]");
        if (!btn.classList.contains("confirming")) {
          btn.classList.add("confirming");
          btn.innerHTML = `${svg("x")} Click again to confirm logout`;
          setTimeout(() => {
            if (btn.classList.contains("confirming")) { btn.classList.remove("confirming"); btn.innerHTML = `${svg("lock")} Log out`; }
          }, 4000);
          return;
        }
        logout();
        closeAllOverlays();
        renderLoginGate();
      };
    }

    function bindPassword() {
      wrap.querySelector("[data-back-to-main]").onclick = () => { screen = "main"; render(); };
      wrap.querySelector("[data-pw-save]").onclick = () => {
        const errEl = wrap.querySelector("[data-pw-error]");
        const current = wrap.querySelector("[data-pw-current]").value;
        const next = wrap.querySelector("[data-pw-new]").value;
        const confirm = wrap.querySelector("[data-pw-confirm]").value;
        function showError(msg) { errEl.textContent = msg; errEl.style.display = "block"; }
        if (!next) { showError("Enter a new password."); return; }
        if (next !== confirm) { showError("Those passwords don't match — retype them and try again."); return; }
        const result = changePassword(current, next);
        if (!result.ok) { showError(result.error); return; }
        notify("Password updated.");
        closeAllOverlays();
      };
    }
    function bindSync() {
      wrap.querySelector("[data-back-to-main]").onclick = () => { screen = "main"; render(); };

      const syncVeil = wrap.querySelector("[data-sync-veil]");
      const syncWrap = wrap.querySelector("[data-sync-code-wrap]");

      if (syncVeil && syncWrap) {
        syncVeil.onclick = () => syncWrap.classList.add("revealed");
      }

      wrap.querySelector("[data-copy-sync]").onclick = () => {
        const code = wrap.querySelector("[data-sync-code]").textContent;
        if (navigator.clipboard) navigator.clipboard.writeText(code).catch(() => {});
        notify("Sync code copied.");
      };
    }

    function bindPersonalization() {
      const preview = wrap.querySelector("[data-settings-avatar-preview]");
      const nameInput = wrap.querySelector("[data-settings-name]");
      const emojiInput = wrap.querySelector("[data-settings-emoji]");
      const fileInput = wrap.querySelector("[data-avatar-file-input]");
      let chosenColor = getPlayerProfile().avatarColor;

      function refreshPreview() {
        if (getAvatarImage()) return; // uploaded photo overrides the emoji/initials preview
        preview.style.background = chosenColor;
        preview.textContent = emojiInput.value.trim() || avatarInitials(nameInput.value);
      }
      wrap.querySelectorAll("[data-avatar-color]").forEach((btn) => btn.onclick = () => {
        chosenColor = btn.dataset.avatarColor;
        wrap.querySelectorAll("[data-avatar-color]").forEach((b) => b.classList.toggle("active", b === btn));
        preview.style.background = chosenColor;
      });
      nameInput.addEventListener("input", refreshPreview);
      emojiInput.addEventListener("input", refreshPreview);

      wrap.querySelector("[data-back-to-main]").onclick = () => { screen = "main"; render(); };
      wrap.querySelector("[data-avatar-upload-btn]").onclick = () => fileInput.click();
      fileInput.onchange = () => {
        const file = fileInput.files && fileInput.files[0];
        fileInput.value = "";
        if (!file) return;
        if (!/^image\/(png|jpeg)$/.test(file.type)) { notify("Please choose a PNG or JPG image."); return; }
        const reader = new FileReader();
        reader.onload = () => openAvatarCropModal(reader.result, () => { screen = "personalization"; render(); notify("Profile picture updated."); });
        reader.readAsDataURL(file);
      };
      const removeBtn = wrap.querySelector("[data-remove-photo]");
      if (removeBtn) removeBtn.onclick = () => { setAvatarImage(""); screen = "personalization"; render(); notify("Profile picture removed."); };

      wrap.querySelector("[data-settings-save]").onclick = () => {
        const errEl = wrap.querySelector("[data-username-error]");
        const newName = nameInput.value.trim();
        const passwordInput = wrap.querySelector("[data-settings-password]");
        const password = passwordInput ? passwordInput.value : "";
        const currentName = getPlayerProfile().name;

        if (newName !== currentName) {
          const result = changeUsername(newName, password);
          if (!result.ok) {
            errEl.textContent = result.error;
            errEl.style.display = "block";
            return;
          }
        }

        setPlayerProfile({ avatarColor: chosenColor, avatarEmoji: emojiInput.value.trim() });
        notify("Profile updated.");
        closeAllOverlays();
      };
    }

    render();
  }

  // ===================== AVATAR UPLOAD → CROP/ZOOM MODAL =====================
  // Lightweight drag-to-reposition + slider-to-zoom cropper. Renders the source image onto a
  // fixed-size canvas (matching the circular preview) and saves the result as a compressed JPEG
  // data-URL via Shell.setAvatarImage, so it persists in localStorage like the rest of the account.
  function openAvatarCropModal(srcDataUrl, onSaved) {
    const OUT = 300; // output crop size in px (square, matches the circular avatar mask)
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-crop-overlay", "");
    wrap.innerHTML = `
      <div class="shell-modal-box crop-modal-box">
        <div class="shell-modal-head">
          <h3>Adjust profile picture</h3>
          <button class="shell-modal-close" data-close-crop aria-label="Close">${svg("x")}</button>
        </div>
        <div class="crop-stage-wrap">
          <canvas class="crop-canvas" width="${OUT}" height="${OUT}" data-crop-canvas></canvas>
          <div class="crop-circle-mask"></div>
        </div>
        <div class="vault-field-label">Zoom</div>
        <input type="range" class="crop-zoom-slider" min="100" max="300" value="100" data-crop-zoom>
        <div class="crop-hint">Drag the image to reposition it.</div>
        <button class="vault-submit" data-crop-save>Save profile picture</button>
      </div>`;
    document.body.appendChild(wrap);
    bindOverlayOutsideClose(wrap);
    wrap.querySelector("[data-close-crop]").onclick = () => wrap.remove();

    const canvas = wrap.querySelector("[data-crop-canvas]");
    const ctx = canvas.getContext("2d");
    const zoomSlider = wrap.querySelector("[data-crop-zoom]");
    const img = new Image();
    let scale = 1, offX = 0, offY = 0, baseScale = 1;

    function draw() {
      ctx.clearRect(0, 0, OUT, OUT);
      ctx.fillStyle = "#0c0e18";
      ctx.fillRect(0, 0, OUT, OUT);
      const w = img.width * baseScale * scale;
      const h = img.height * baseScale * scale;
      const x = (OUT - w) / 2 + offX;
      const y = (OUT - h) / 2 + offY;
      ctx.drawImage(img, x, y, w, h);
    }
    function clampOffsets() {
      const w = img.width * baseScale * scale;
      const h = img.height * baseScale * scale;
      const maxX = Math.max(0, (w - OUT) / 2);
      const maxY = Math.max(0, (h - OUT) / 2);
      offX = Math.max(-maxX, Math.min(maxX, offX));
      offY = Math.max(-maxY, Math.min(maxY, offY));
    }
    img.onload = () => {
      baseScale = Math.max(OUT / img.width, OUT / img.height);
      draw();
    };
    img.src = srcDataUrl;

    zoomSlider.addEventListener("input", () => {
      scale = parseInt(zoomSlider.value, 10) / 100;
      clampOffsets();
      draw();
    });

    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener("mousedown", (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      offX += e.clientX - lastX;
      offY += e.clientY - lastY;
      lastX = e.clientX; lastY = e.clientY;
      clampOffsets();
      draw();
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    canvas.addEventListener("touchstart", (e) => { const t = e.touches[0]; dragging = true; lastX = t.clientX; lastY = t.clientY; }, { passive: true });
    canvas.addEventListener("touchmove", (e) => {
      if (!dragging) return;
      const t = e.touches[0];
      offX += t.clientX - lastX; offY += t.clientY - lastY;
      lastX = t.clientX; lastY = t.clientY;
      clampOffsets();
      draw();
    }, { passive: true });
    canvas.addEventListener("touchend", () => { dragging = false; });

    wrap.querySelector("[data-crop-save]").onclick = () => {
      // Compress: JPEG at moderate quality keeps the localStorage footprint small.
      const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
      setAvatarImage(dataUrl);
      wrap.remove();
      if (onSaved) onSaved();
    };
  }

  // ===================== REWARDS QUICK DROPDOWN (present icon) =====================
  // ===================== claim result modal (shown after claiming a reward) =====================
  // Confirms how much was just claimed. Closes ONLY via the X button or a real outside click —
  // never as a side effect of something else re-rendering, since it uses its own overlay/backdrop
  // separate from the rewards dropdown it was opened from.
  function claimResultModalHTML(label, amount) {
    return `
      <div class="shell-modal-box claimresult-box">
        <div class="shell-modal-head">
          <h3>${svg("gift")} Reward Claimed</h3>
          <button class="shell-modal-close" data-claimresult-close aria-label="Close">${svg("x")}</button>
        </div>
        <div class="claimresult-body">
          <div class="claimresult-icon">${svg("spark")}</div>
          <div class="claimresult-label">${label}</div>
          <div class="claimresult-amount">+${fmtMoney(amount)}</div>
          <div class="claimresult-sub">Added to your balance.</div>
        </div>
      </div>`;
  }
  function openClaimResultModal(label, amount) {
    document.querySelectorAll("[data-claimresult-overlay]").forEach((el) => el.remove());
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-claimresult-overlay", "");
    wrap.innerHTML = claimResultModalHTML(label, amount);
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    // Deliberately NOT using bindOverlayOutsideClose/closeAllOverlays here — this modal can be
    // opened while the rewards dropdown is still open behind it, and closing it (via X or an
    // outside click) must only remove itself, not the rewards dropdown too.
    let downOnBackdrop = false;
    wrap.addEventListener("mousedown", (e) => { downOnBackdrop = (e.target === wrap); });
    wrap.addEventListener("click", (e) => {
      e.stopPropagation();
      if (downOnBackdrop && e.target === wrap) close();
      downOnBackdrop = false;
    });
    wrap.querySelector("[data-claimresult-close]").onclick = (e) => { e.stopPropagation(); close(); };
  }

  function openRewardsDropdown(anchorBtn) {
    closeAllOverlays();
    const stats = rankStats();
    const silverUnlocked = stats.tier >= RANK_TIERS + 1; // Silver I
    const dd = document.createElement("div");
    dd.className = "shell-dropdown right rewards-dropdown";
    dd.setAttribute("data-rewards-dropdown", "");

    function rowHTML(icon, label, key, lockedUntilSilver) {
      if (lockedUntilSilver && !silverUnlocked) {
        return `<div class="rewards-row"><span>${svg(icon)} ${label}</span><span class="rewards-row-action locked">${svg("lock")}</span></div>`;
      }
      const rem = claimRemaining(key);
      if (rem > 0) return `<div class="rewards-row"><span>${svg(icon)} ${label}</span><span class="rewards-row-sub">${fmtCountdown(rem)}</span></div>`;
      return `<div class="rewards-row"><span>${svg(icon)} ${label}</span><button class="rewards-row-action" data-reward-claim="${key}">Claim $${REWARD_AMOUNTS[key].toFixed(2)}</button></div>`;
    }

    function paint() {
      dd.innerHTML = `
        <a class="rewards-raffle" href="./wheel.html" style="text-decoration:none;"><div class="rewards-raffle-icon">${svg("gift")}</div><div class="rewards-raffle-copy"><strong>Wager Case</strong><span>OPEN FOR A PRIZE</span></div><span class="rewards-raffle-tickets">${svg("spark")} ${raffleSpinsAvailable()}</span></a>
        <div class="rewards-boost-row"><span>${svg("bolt")} 10% Boost</span><span class="rewards-boost-timer">${fmtClock(getBoostRemaining())}</span></div>
        <div class="rewards-row"><span>${svg("sparkles")} Weekly Freespins</span><span class="rewards-row-action locked">${svg("lock")}</span></div>
        <div class="rewards-row"><span>${svg("bolt")} Daily Reload</span><span class="rewards-row-sub">Pending $0.00</span></div>
        <div class="rewards-row"><span>${svg("rotate")} Rakeback</span>${getRakebackAvailable() >= 0.01 ? `<button class="rewards-row-action" data-rakeback-claim>Claim ${fmtMoney(getRakebackAvailable())}</button>` : `<span class="rewards-row-action locked" style="cursor:default;">$0.00</span>`}</div>
        ${rowHTML("spark", "Daily Bonus", "daily")}
        ${rowHTML("spark", "Weekly Bonus", "weekly")}
        ${rowHTML("spark", "Pre-Monthly Bonus", "preMonthly", true)}
        ${rowHTML("spark", "Monthly Bonus", "monthly")}
        <a class="rewards-all-btn" href="./rewards.html">All Rewards</a>`;
      dd.querySelectorAll("[data-reward-claim]").forEach((btn) => btn.onclick = (e) => {
        e.stopPropagation();
        const key = btn.dataset.rewardClaim;
        const amount = claimReward(key);
        if (amount) {
          notify(`Claimed ${fmtMoney(amount)}.`);
          addNotification({ type: "reward", title: `${key.charAt(0).toUpperCase()}${key.slice(1)} bonus claimed`, detail: `+${fmtMoney(amount)} added to your balance.` });
          refreshNotifDot();
          openClaimResultModal(key.charAt(0).toUpperCase() + key.slice(1) + " Bonus", amount);
          paint();
        }
      });
      const rbBtn = dd.querySelector("[data-rakeback-claim]");
      if (rbBtn) rbBtn.onclick = (e) => {
        e.stopPropagation();
        const amount = claimRakeback();
        if (amount) {
          notify(`Claimed ${fmtMoney(amount)} in rakeback.`);
          addNotification({ type: "reward", title: "Rakeback claimed", detail: `+${fmtMoney(amount)} added to your balance.` });
          refreshNotifDot();
          openClaimResultModal("Rakeback", amount);
          paint();
        }
      };
    }
    paint();

    anchorBtn.parentElement.style.position = anchorBtn.parentElement.style.position || "relative";
    anchorBtn.insertAdjacentElement("afterend", dd);
    dd.style.position = "absolute";

    setTimeout(() => document.addEventListener("click", outsideCloser), 0);
    function outsideCloser(e) {
      if (!dd.contains(e.target) && e.target !== anchorBtn) { dd.remove(); document.removeEventListener("click", outsideCloser); }
    }
  }

  // ===================== CURRENCY DROPDOWN =====================
  // Opens right under the balance box, lets the player pick which balance they're currently
  // wagering with, and offers "Exchange Currency" to convert reward balance into cash.
  function openCurrencyDropdown(anchorBtn) {
    closeAllOverlays();
    const dd = document.createElement("div");
    dd.className = "shell-dropdown currency-dropdown";
    dd.setAttribute("data-currency-dropdown", "");

    function rowHTML(cur, label, amount) {
      const active = getActiveCurrency() === cur;
      const icon = cur === "reward" ? svg("rewardcoin") : svg("cashcoin");
      return `<button class="currency-row ${active ? "active" : ""}" data-currency-pick="${cur}">
        <span class="currency-row-left">${icon}<span>${label}</span></span>
        <span class="currency-row-amt">${fmtMoney(amount)}</span>
      </button>`;
    }

    function paint() {
      dd.innerHTML = `
        ${rowHTML("cash", "Cash Balance", getCashBalance())}
        ${rowHTML("reward", "Reward Balance", getRewardBalance())}
        <div class="currency-dropdown-divider"></div>
        <button class="currency-exchange-btn" data-currency-exchange>${svg("rotate")} Exchange Currency</button>`;
      dd.querySelectorAll("[data-currency-pick]").forEach((btn) => btn.onclick = (e) => {
        e.stopPropagation();
        setActiveCurrency(btn.dataset.currencyPick);
        refreshCurrencyChrome();
        paint();
      });
      dd.querySelector("[data-currency-exchange]").onclick = (e) => {
        e.stopPropagation();
        dd.remove();
        document.removeEventListener("click", outsideCloser);
        openExchangeModal();
      };
    }
    paint();

    const box = anchorBtn.closest(".credit") || anchorBtn.parentElement;
    // IMPORTANT: don't touch box.parentElement's inline style here — on the topbar, that parent
    // is .top-center-fixed, which relies on `position: fixed; left: 50%; transform: translateX(-50%)`
    // to stay centered. Setting an inline position on it (even "relative") overrides that CSS and
    // knocks the whole centered balance/vault cluster out of place. Anchor to `box` itself instead,
    // which already has `position: relative` from the stylesheet.
    box.appendChild(dd);
    dd.style.position = "absolute";
    dd.style.top = "calc(100% + 10px)";
    dd.style.left = "50%";
    dd.style.transform = "translateX(-50%)";

    setTimeout(() => document.addEventListener("click", outsideCloser), 0);
    function outsideCloser(e) {
      if (!dd.contains(e.target) && e.target !== anchorBtn) { dd.remove(); document.removeEventListener("click", outsideCloser); }
    }
  }

  // Keeps every balance-box icon/label/border in sync with the active currency, in this tab,
  // right away (no full re-mount needed).
  function refreshCurrencyChrome() {
    const cur = getActiveCurrency();
    document.querySelectorAll("[data-currency-box]").forEach((el) => el.classList.toggle("reward-active", cur === "reward"));
    document.querySelectorAll("[data-shell-currency-icon]").forEach((el) => el.innerHTML = currencyCoinHTML());
    document.querySelectorAll("[data-shell-balance]").forEach((el) => el.textContent = fmtMoney(getBalance()));
  }

  // ===================== EXCHANGE CURRENCY MODAL =====================
  // Converts reward balance into cash, 1:1 — but only up to whatever's currently unlocked by
  // wagering (see rewardConvertibleNow in the reward-lock section). This is the ONLY way reward
  // balance ever becomes real cash.
  function openExchangeModal() {
    closeAllOverlays();
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-exchange-overlay", "");
    document.body.appendChild(wrap);

    function render() {
      const lock = getRewardLockState();
      const reward = getRewardBalance();
      const required = lock.totalClaimed;
      const wageredTowards = Math.min(lock.totalWagered, required);
      const pct = required > 0 ? Math.min(100, (wageredTowards / required) * 100) : 100;
      const convertible = rewardConvertibleNow();

      wrap.innerHTML = `
        <div class="shell-modal-box exchange-box">
          <div class="shell-modal-head">
            <h3>${svg("rotate")} Exchange Currency</h3>
            <button class="shell-modal-close" data-close-exchange aria-label="Close">${svg("x")}</button>
          </div>
          <p class="vault-blurb">Reward balance converts to cash 1:1 — but only once it's been wagered through games first. Claiming a code and instantly cashing it out isn't possible.</p>
          <div class="vault-balance-row"><span>${svg("rewardcoin")} Reward Balance</span><strong>${fmtMoney(reward)}</strong></div>
          <div class="exchange-progress-label"><span>Wagered toward unlock</span><span>${fmtMoney(wageredTowards)} / ${fmtMoney(required)}</span></div>
          <div class="rank-progress-track"><div class="rank-progress-fill" style="width:${pct}%; background:linear-gradient(90deg,#b06bff,#7c3fd6);"></div></div>
          <div class="vault-balance-row" style="margin-top:12px;"><span>${svg("cashcoin")} Available to convert now</span><strong style="color:#5cffe7;">${fmtMoney(convertible)}</strong></div>
          <div class="vault-field-label" style="margin-top:14px;">Amount to convert</div>
          <div class="vault-input-row">
            <span class="prefix">$</span>
            <input type="text" inputmode="decimal" placeholder="0.00" data-exchange-amount>
            <button class="max-btn" data-exchange-max>Max</button>
          </div>
          <button class="vault-submit" data-exchange-submit disabled>Convert to Cash</button>
        </div>`;

      const amountInput = wrap.querySelector("[data-exchange-amount]");
      const submitBtn = wrap.querySelector("[data-exchange-submit]");
      function refreshBtn() {
        const amt = parseFloat(amountInput.value);
        submitBtn.disabled = !(amt > 0 && amt <= convertible + 0.001);
      }
      amountInput.addEventListener("input", refreshBtn);
      wrap.querySelector("[data-exchange-max]").onclick = () => { amountInput.value = convertible.toFixed(2); refreshBtn(); };
      submitBtn.onclick = () => {
        const amt = Math.round(parseFloat(amountInput.value) * 100) / 100;
        const converted = convertRewardToCash(amt);
        if (converted > 0) {
          notify(`Converted ${fmtMoney(converted)} of reward balance to cash.`);
          addNotification({ type: "reward", title: "Reward balance converted", detail: `+${fmtMoney(converted)} added to your cash balance.` });
          refreshCurrencyChrome();
          render();
        }
      };
      wrap.querySelector("[data-close-exchange]").onclick = closeAllOverlays;
    }
    render();
    bindOverlayOutsideClose(wrap);
  }

  // ===================== shared "close on outside click only" helper =====================
  // Fixes the drag-out-to-close bug: a mousedown that starts INSIDE the modal box (e.g. selecting
  // text or dragging a slider) but is released outside the box must NOT close the modal. We only
  // close when both the mousedown and the click/mouseup land directly on the backdrop itself.
  function bindOverlayOutsideClose(wrap) {
    let downOnBackdrop = false;
    wrap.addEventListener("mousedown", (e) => { downOnBackdrop = (e.target === wrap); });
    wrap.addEventListener("click", (e) => {
      if (downOnBackdrop && e.target === wrap) closeAllOverlays();
      downOnBackdrop = false;
    });
  }

  // ===================== shared close-all ====================
  function closeAllOverlays() {
    document.querySelectorAll("[data-vault-overlay], [data-earn-overlay], [data-search-overlay], [data-profile-modal-overlay], [data-settings-overlay], [data-betdetail-overlay], [data-claimresult-overlay], [data-exchange-overlay]").forEach((el) => el.remove());
    document.querySelectorAll("[data-notif-dropdown], [data-profile-dropdown], [data-rewards-dropdown], [data-currency-dropdown]").forEach((el) => el.remove());
    if (earnTickTimer) { clearInterval(earnTickTimer); earnTickTimer = null; }
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAllOverlays(); });

  function bindChrome(opts) {
    document.querySelectorAll("[data-shell-vault]").forEach((btn) => btn.onclick = () => openVaultModal());
    document.querySelectorAll("[data-shell-earn]").forEach((btn) => btn.onclick = () => { window.location.href = "./earn.html"; });
    document.querySelectorAll("[data-shell-search]").forEach((btn) => btn.onclick = () => openSearchModal());
    document.querySelectorAll("[data-shell-rewards]").forEach((btn) => btn.onclick = (e) => {
      e.stopPropagation();
      const existing = document.querySelector("[data-rewards-dropdown]");
      if (existing) { existing.remove(); return; }
      openRewardsDropdown(btn);
    });
    document.querySelectorAll("[data-shell-currency-toggle]").forEach((btn) => btn.onclick = (e) => {
      e.stopPropagation();
      const existing = document.querySelector("[data-currency-dropdown]");
      if (existing) { existing.remove(); return; }
      openCurrencyDropdown(btn);
    });
    document.querySelectorAll("[data-shell-notify]").forEach((btn) => btn.onclick = (e) => {
      e.stopPropagation();
      const existing = document.querySelector("[data-notif-dropdown]");
      if (existing) { existing.remove(); return; }
      openNotifDropdown(btn);
    });
    document.querySelectorAll("[data-shell-profile]").forEach((btn) => btn.onclick = (e) => {
      e.stopPropagation();
      const existing = document.querySelector("[data-profile-dropdown]");
      if (existing) { existing.remove(); return; }
      openProfileDropdown(btn);
    });
    document.querySelectorAll("[data-shell-recent-played]").forEach((btn) => btn.onclick = (e) => { e.preventDefault(); notify("Recently played is coming soon."); });
    document.querySelectorAll("[data-shell-profile-open]").forEach((btn) => btn.onclick = (e) => { e.stopPropagation(); openProfileModal(); });
    document.querySelectorAll("[data-shell-case-cta]").forEach((btn) => btn.onclick = () => { window.location.href = "./wheel.html"; });
    document.querySelectorAll("[data-shell-new-releases]").forEach((btn) => btn.onclick = (e) => { e.preventDefault(); notify("New releases are coming soon."); });

    const menuBtn = document.querySelector("[data-shell-menu]");
    if (menuBtn) menuBtn.onclick = () => document.querySelector(".rail")?.classList.toggle("open");

    const collapseBtn = document.querySelector("[data-shell-collapse]");
    if (collapseBtn) collapseBtn.onclick = () => {
      const rail = document.querySelector(".rail");
      const grid = document.querySelector(".site-grid");
      const collapsed = !isSidebarCollapsed();
      setSidebarCollapsed(collapsed);
      if (rail) rail.classList.toggle("collapsed", collapsed);
      if (grid) grid.classList.toggle("sidebar-collapsed", collapsed);
      if (grid) grid.classList.toggle("sidebar-expanded", !collapsed);
      const icon = collapseBtn.querySelector("span");
      if (icon) icon.style.transform = collapsed ? "rotate(180deg)" : "none";
      collapseBtn.setAttribute("data-hover-tip", collapsed ? "Expand" : "Collapse");
    };

    const originalsToggle = document.querySelector("[data-originals-toggle]");
    if (originalsToggle) originalsToggle.onclick = () => {
      const body = document.querySelector("[data-originals-body]");
      const isOpen = body?.classList.toggle("open");
      const arrow = originalsToggle.querySelector("[data-originals-arrow]");
      if (arrow) arrow.style.transform = isOpen ? "rotate(180deg)" : "none";
      const dd = getRailDropdownState(); dd.originals = !!isOpen; setRailDropdownState(dd);
    };
    const slotsToggle = document.querySelector("[data-slots-toggle]");
    if (slotsToggle) slotsToggle.onclick = () => {
      const body = document.querySelector("[data-slots-body]");
      const isOpen = body?.classList.toggle("open");
      const arrow = slotsToggle.querySelector("[data-slots-arrow]");
      if (arrow) arrow.style.transform = isOpen ? "rotate(180deg)" : "none";
      const dd = getRailDropdownState(); dd.slots = !!isOpen; setRailDropdownState(dd);
    };

    // settings cog works identically whether the sidebar is collapsed or full-width
    document.querySelectorAll("[data-shell-settings]").forEach((btn) => btn.onclick = () => openSettingsModal());

    const devToggleBtn = document.querySelector("[data-dev-toggle]");
    if (devToggleBtn) devToggleBtn.onclick = () => {
      setDevPanelOpen(!isDevPanelOpen());
      renderDevFloatingPanel();
    };
    renderDevFloatingPanel();

    document.addEventListener("nj:balance", (e) => {
      document.querySelectorAll("[data-shell-balance]").forEach((el) => el.textContent = fmtMoney(e.detail));
    });
    document.addEventListener("nj:currency", () => refreshCurrencyChrome());
    document.addEventListener("nj:cases", (e) => {
      document.querySelectorAll("[data-shell-case-badge]").forEach((el) => el.textContent = e.detail);
    });
    // Show/hide the wrench icon the instant developer access is unlocked/enabled or
    // locked/disabled, instead of waiting for the next full page repaint/refresh.
    document.addEventListener("nj:developer", (e) => {
      const shouldShow = !!e.detail;
      document.querySelectorAll(".top-center-fixed").forEach((container) => {
        let btn = container.querySelector("[data-dev-toggle]");
        if (shouldShow && !btn) {
          btn = document.createElement("button");
          btn.className = "icon-button dev-toggle-btn hover-tip";
          btn.setAttribute("data-hover-tip", "Developer tools");
          btn.setAttribute("data-dev-toggle", "");
          btn.setAttribute("aria-label", "Developer tools");
          btn.innerHTML = svg("wrench");
          btn.onclick = () => { setDevPanelOpen(!isDevPanelOpen()); renderDevFloatingPanel(); };
          container.insertBefore(btn, container.firstChild);
        } else if (!shouldShow && btn) {
          btn.remove();
          setDevPanelOpen(false);
          renderDevFloatingPanel();
        }
      });
    });

    // keep passive earnings accruing in the background even while the earn modal is closed
    earnTick();
  }

  let boostTickTimer = null;
  let toastTimer = null;
  function notify(message) {
    let el = document.querySelector(".site-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "toast site-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  function mount({ activeTab = "Lobby", topbarTarget = "#site-topbar", sidebarTarget = "#site-sidebar" } = {}) {
    clearStaleDevSnapshot();
    applyAnimationsClass();
    const top = document.querySelector(topbarTarget);
    const side = document.querySelector(sidebarTarget);
    if (top) top.innerHTML = topbarHTML();
    if (side) side.innerHTML = sidebarHTML(activeTab);
    const grid = document.querySelector(".site-grid");
    if (grid) grid.classList.toggle("sidebar-collapsed", isSidebarCollapsed());
    if (grid) grid.classList.toggle("sidebar-expanded", !isSidebarCollapsed());
    bindChrome();
    if (isLoggedOut()) {
      renderLoginGate();
    } else {
      // NEW — pull down any newer progress from another device, then repaint the chrome
      // (balance, favorites badge, etc.) once it lands.
      pullLatestAccountIfNewer().then(() => {
        const topEl = document.querySelector(topbarTarget);
        const sideEl = document.querySelector(sidebarTarget);
        if (topEl) topEl.innerHTML = topbarHTML();
        if (sideEl) sideEl.innerHTML = sidebarHTML(activeTab);
        bindChrome();
        document.dispatchEvent(new CustomEvent("nj:chrome-repainted"));
      });
    }
    setupAccountAutosave();
    setupVisibilityResync();
    startLiveAccountSync();
  }

  let __njAutosaveSetup = false;
  let __njLastAutosaveSnapshot = "";
  function setupAccountAutosave() {
    if (__njAutosaveSetup) return;
    __njAutosaveSetup = true;
    setInterval(() => {
      if (document.hidden) return;
      if (liveAccountPullInFlight) return; // don't autosave while we're mid-resync
      if (isLoggedOut()) return;
      // Only actually push to Firebase if something in the snapshot has changed since the
      // last time we pushed — otherwise this was silently re-uploading (and re-downloading,
      // via our own liveAccounts listener) the full account blob, including any uploaded
      // avatar image, every 20 seconds forever, whether or not anything changed.
      const snap = JSON.stringify(snapshotCurrentState());
      if (snap === __njLastAutosaveSnapshot) { persistActiveAccount(); return; }
      __njLastAutosaveSnapshot = snap;
      persistActiveAccount();
      pushLiveAccountState();
    }, 20000);
    window.addEventListener("beforeunload", () => {
      if (!isLoggedOut() && !document.hidden && !liveAccountPullInFlight) {
        persistActiveAccount();
        pushLiveAccountState();
      }
    });
  }

  // ===================== LOGOUT / LOGIN GATE =====================
  // A full-screen overlay that blocks interaction with the rest of the app after Logout. Two
  // tabs: "Register" creates a brand-new player from scratch (name + personalization only —
  // balance, rank, bets, everything else starts at defaults, same as a first-time visitor) and
  // saves it into the account registry under a chosen username/password. "Log In" asks for that
  // username/password and restores whichever account it belongs to. A player who only has an old
  // sync code can use "Have a sync code from before?" on the Register tab to attach that existing
  // progress to a new username/password instead of starting fresh — that's a one-time migration
  // path, not an ongoing login method. Nothing in localStorage is touched by Logout itself beyond
  // saving the current session's progress back to the active account — Register/Login are the
  // only actions here that change which account's data is loaded.
  function renderLoginGate({ switching = false } = {}) {
    document.querySelectorAll("[data-login-gate]").forEach((el) => el.remove());
    const colors = ["#5cffe7", "#3aa0ff", "#ff5c9f", "#ffcf7d", "#c98bff", "#ff6e8f"];
    let tab = switching ? "login" : "register";
    let chosenColor = colors[0];
    let registerError = "";
    let loginError = "";
    // When set, Register is creating an account from a legacy sync code's progress instead of
    // starting fresh — staged here after the player pastes a code on the "Have a sync code?" step.
    let stagedSyncData = null;

    const wrap = document.createElement("div");
    wrap.className = "login-gate";
    wrap.setAttribute("data-login-gate", "");
    document.body.appendChild(wrap);

    function render() {
      wrap.innerHTML = `
        <div class="login-gate-box wide">
          <div class="login-gate-logo">${svg("spark")} Neon Jackpot</div>
          ${switching ? `<p class="login-gate-blurb" style="margin-top:-6px;">Switching accounts — your current progress has been saved.</p>` : ""}
          <div class="earn-tabs login-gate-tabs">
            <button class="earn-tab ${tab === "register" ? "active" : ""}" data-lg-tab="register">Register</button>
            <button class="earn-tab ${tab === "login" ? "active" : ""}" data-lg-tab="login">Log In</button>
          </div>
          ${tab === "register" ? registerHTML() : loginHTML()}
          ${switching ? `<button class="vault-submit" style="margin-top:8px;background:#1b2032;color:#b6bfd2;" data-lg-switch-cancel>Cancel, stay on this account</button>` : ""}
        </div>`;
      wrap.querySelectorAll("[data-lg-tab]").forEach((b) => b.onclick = () => {
        tab = b.dataset.lgTab; registerError = ""; loginError = ""; render();
      });
      if (tab === "register") bindRegister(); else bindLogin();
      if (switching) {
        const cancelBtn = wrap.querySelector("[data-lg-switch-cancel]");
        if (cancelBtn) cancelBtn.onclick = () => { wrap.remove(); };
      }
    }

    function registerHTML() {
      if (stagedSyncData) {
        return `
          <p class="login-gate-blurb">Sync code recognized — pick a username and password to attach that progress to going forward.</p>
          <div class="vault-field-label">Username</div>
          <div class="vault-input-row"><input type="text" maxlength="24" placeholder="Choose a username" data-lg-username autocomplete="off"></div>
          <div class="vault-field-label">Password</div>
          <div class="vault-input-row"><input type="password" placeholder="Choose a password" data-lg-password autocomplete="off"></div>
          <div class="vault-field-label">Retype password</div>
          <div class="vault-input-row"><input type="password" placeholder="Retype password" data-lg-password-confirm autocomplete="off"></div>
          ${registerError ? `<div class="gift-error">${registerError}</div>` : ""}
          <button class="vault-submit" data-lg-register>Create account with this progress</button>
          <button class="vault-submit" style="margin-top:8px;background:#1b2032;color:#b6bfd2;" data-lg-cancel-sync>Cancel</button>`;
      }
      return `
        <p class="login-gate-blurb">Create a brand-new player — this starts completely fresh (balance, rank, and bets all reset). Your username IS your display name — there's no separate one to forget.</p>
        <div class="settings-avatar-row">
          <div class="profile-avatar-lg" data-lg-avatar-preview style="background:${chosenColor};">NV</div>
          <div class="settings-swatches-col">
            <div class="settings-swatches">${colors.map((c) => `<button class="settings-swatch ${c === chosenColor ? "active" : ""}" data-lg-color="${c}" style="background:${c};" aria-label="Choose color"></button>`).join("")}</div>
            <span class="settings-swatch-hint">Color shows behind your emoji/initials</span>
          </div>
        </div>
        <div class="vault-field-label">Avatar emoji (optional)</div>
        <div class="vault-input-row"><input type="text" maxlength="2" placeholder="e.g. 🎲" data-lg-emoji></div>
        <div class="vault-field-label">Username (this is also your display name)</div>
        <div class="vault-input-row"><input type="text" maxlength="18" placeholder="Choose a username" data-lg-username autocomplete="off"></div>
        <div class="vault-field-label">Password</div>
        <div class="vault-input-row"><input type="password" placeholder="Choose a password" data-lg-password autocomplete="off"></div>
        <div class="vault-field-label">Retype password</div>
        <div class="vault-input-row"><input type="password" placeholder="Retype password" data-lg-password-confirm autocomplete="off"></div>
        ${registerError ? `<div class="gift-error">${registerError}</div>` : ""}
        <button class="vault-submit" data-lg-register>Create account</button>
        <button class="vault-submit" style="margin-top:8px;background:#1b2032;color:#b6bfd2;" data-lg-have-sync>Have a sync code from before?</button>`;
    }

    function knownAccountsHTML() {
      const accts = getAccounts();
      const current = getActiveAccountUsername();
      const others = Object.keys(accts).filter((u) => u !== current);
      if (!others.length) return "";
      return `
        <div class="vault-field-label">Quick switch</div>
        <div class="login-gate-known-accounts">
          ${others.map((u) => `
            <div class="login-gate-known-row">
              <button class="login-gate-known-acct" data-lg-known-acct="${u}">${svg("user")} ${u}</button>
              <button class="login-gate-known-remove hover-tip" data-hover-tip="Remove" data-lg-remove-acct="${u}" aria-label="Remove ${u} from this list">${svg("x")}</button>
            </div>`).join("")}
        </div>
        <div class="settings-swatch-hint" style="margin:6px 0 14px;">Or log in with a different username below</div>`;
    }

    function loginHTML() {
      return `
        <p class="login-gate-blurb">Log in with your username and password to load your account back in — same balance, bets, and progress, on any device.</p>
        ${knownAccountsHTML()}
        <div class="vault-field-label">Username</div>
        <div class="vault-input-row"><input type="text" maxlength="24" placeholder="Your username" data-lg-login-username autocomplete="off"></div>
        <div class="vault-field-label">Password</div>
        <div class="vault-input-row"><input type="password" placeholder="Your password" data-lg-login-password autocomplete="off"></div>
        ${loginError ? `<div class="gift-error">${loginError}</div>` : ""}
        <button class="vault-submit" data-lg-login style="margin-top:6px;">Log in</button>`;
    }

    function bindRegister() {
      if (stagedSyncData) {
        wrap.querySelector("[data-lg-cancel-sync]").onclick = () => { stagedSyncData = null; registerError = ""; render(); };
        wrap.querySelector("[data-lg-register]").onclick = () => {
          const username = wrap.querySelector("[data-lg-username]").value;
          const password = wrap.querySelector("[data-lg-password]").value;
          const confirmPw = wrap.querySelector("[data-lg-password-confirm]").value;
          if (password !== confirmPw) { registerError = "Those passwords don't match — retype them and try again."; render(); return; }
          const result = registerAccount({ username, password, seedSnapshot: stagedSyncData });
          if (!result.ok) { registerError = result.error; render(); return; }
          notify("Account created with your synced progress. Welcome back!");
          setTimeout(() => window.location.reload(), 500);
        };
        return;
      }
      const preview = wrap.querySelector("[data-lg-avatar-preview]");
      const usernameInput = wrap.querySelector("[data-lg-username]");
      const emojiInput = wrap.querySelector("[data-lg-emoji]");
      function refreshPreview() {
        preview.style.background = chosenColor;
        preview.textContent = emojiInput.value.trim() || avatarInitials(usernameInput.value);
      }
      wrap.querySelectorAll("[data-lg-color]").forEach((btn) => btn.onclick = () => {
        chosenColor = btn.dataset.lgColor;
        wrap.querySelectorAll("[data-lg-color]").forEach((b) => b.classList.toggle("active", b === btn));
        refreshPreview();
      });
      usernameInput.addEventListener("input", refreshPreview);
      emojiInput.addEventListener("input", refreshPreview);
      wrap.querySelector("[data-lg-register]").onclick = () => {
        const username = usernameInput.value;
        const password = wrap.querySelector("[data-lg-password]").value;
        const confirmPw = wrap.querySelector("[data-lg-password-confirm]").value;
        if (password !== confirmPw) { registerError = "Those passwords don't match — retype them and try again."; render(); return; }
        const result = registerAccount({ username, password, avatarColor: chosenColor, avatarEmoji: emojiInput.value });
        if (!result.ok) { registerError = result.error; render(); return; }
        notify("Account created. Welcome!");
        setTimeout(() => window.location.reload(), 500);
      };
      wrap.querySelector("[data-lg-have-sync]").onclick = () => {
        const code = window.prompt("Paste your old sync code:");
        if (!code) return;
        const data = decodeSyncCodeForMigration(code);
        if (!data) { registerError = "That code couldn't be read. Double-check it and try again."; render(); return; }
        stagedSyncData = data;
        registerError = "";
        render();
      };
    }

    function bindLogin() {
      wrap.querySelectorAll("[data-lg-known-acct]").forEach((btn) => btn.onclick = () => {
        const uname = btn.dataset.lgKnownAcct;
        if (switchToKnownAccount(uname)) {
          notify(`Switched to ${uname}. Welcome back!`);
          setTimeout(() => window.location.reload(), 400);
        }
      });
      wrap.querySelectorAll("[data-lg-remove-acct]").forEach((btn) => btn.onclick = (e) => {
        e.stopPropagation();
        const uname = btn.dataset.lgRemoveAcct;
        if (!btn.classList.contains("confirming")) {
          btn.classList.add("confirming");
          btn.innerHTML = svg("x");
          btn.setAttribute("data-hover-tip", `Click again to remove ${uname}`);
          const resetTimer = setTimeout(() => {
            if (btn.isConnected) { btn.classList.remove("confirming"); btn.setAttribute("data-hover-tip", "Remove"); }
          }, 4000);
          btn._removeResetTimer = resetTimer;
          return;
        }
        clearTimeout(btn._removeResetTimer);
        if (removeSavedAccount(uname)) {
          notify(`Removed ${uname} from this list.`);
          render();
        }
      });
      wrap.querySelector("[data-lg-login]").onclick = async () => {
        const username = wrap.querySelector("[data-lg-login-username]").value;
        const password = wrap.querySelector("[data-lg-login-password]").value;
        const btn = wrap.querySelector("[data-lg-login]");
        btn.disabled = true;
        btn.textContent = "Logging in…";
        const success = await loginToAccount(username, password);
        if (success) {
          notify("Account loaded. Welcome back!");
          setTimeout(() => window.location.reload(), 500);
        } else {
          btn.disabled = false;
          btn.textContent = "Log in";
          loginError = "Incorrect username or password.";
          render();
        }
      };
    }

    render();
  }

  // ---------- shared equity-curve chart (dual-color: green above zero, red below) ----------
  // Renders a single cumulative-profit polyline whose fill/stroke color switches segment-by-segment
  // at every zero-crossing, so one line can show both green (profit) and red (loss) sections at once.
  // The view always auto-scales so the whole line is visible (no clipping top/bottom or left/right).
  function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function chartSvgHTML(betLog) {
    let running = 0;
    const series = betLog.length ? [0, ...betLog.map((b) => (running += b.profit))] : [0, 0];
    // pad maxAbs by 15% so peaks never sit exactly on the edge of the viewBox (which was
    // clipping/hiding the top or bottom of the line)
    const maxAbs = Math.max(20, ...series.map((v) => Math.abs(v))) * 1.15;
    const top = 8, bottom = 92, mid = (top + bottom) / 2;
    const yFor = (v) => mid - clampNum(v / maxAbs, -1, 1) * (mid - top);
    const points = series.map((value, index) => ({
      value,
      x: (index / Math.max(series.length - 1, 1)) * 100,
      y: yFor(value),
    }));
    const zeroY = mid;

    const upSegs = [], downSegs = [];
    let cur = [points[0]];
    let curSign = points[0].value >= 0 ? "up" : "down";
    for (let i = 1; i < points.length; i++) {
      const prev = points[i - 1], p = points[i];
      const sign = p.value >= 0 ? "up" : "down";
      if (sign !== curSign && prev.value !== 0) {
        const t = prev.value / (prev.value - p.value);
        const xi = prev.x + t * (p.x - prev.x);
        cur.push({ x: xi, y: zeroY, value: 0 });
        (curSign === "up" ? upSegs : downSegs).push(cur);
        cur = [{ x: xi, y: zeroY, value: 0 }];
        curSign = sign;
      }
      cur.push(p);
    }
    (curSign === "up" ? upSegs : downSegs).push(cur);

    // Smooth curve: quadratic Bezier through the midpoint of each pair of points, same
    // technique used for crash.html's curve — removes the sharp straight-line-segment look.
    function smoothPath(seg) {
      if (seg.length < 2) return `M ${seg[0].x},${seg[0].y}`;
      let d = `M ${seg[0].x},${seg[0].y}`;
      for (let i = 1; i < seg.length - 1; i++) {
        const cx = seg[i].x, cy = seg[i].y;
        const nx = (seg[i].x + seg[i + 1].x) / 2;
        const ny = (seg[i].y + seg[i + 1].y) / 2;
        d += ` Q ${cx},${cy} ${nx},${ny}`;
      }
      const last = seg[seg.length - 1];
      d += ` L ${last.x},${last.y}`;
      return d;
    }
    function smoothArea(seg) {
      const first = seg[0], last = seg[seg.length - 1];
      return `${smoothPath(seg)} L ${last.x},${zeroY} L ${first.x},${zeroY} Z`;
    }

    const areas = [
      ...upSegs.map((seg) => `<path class="stats-area-up" d="${smoothArea(seg)}"/>`),
      ...downSegs.map((seg) => `<path class="stats-area-down" d="${smoothArea(seg)}"/>`),
    ].join("");
    const lines = [
      ...upSegs.map((seg) => `<path class="stats-line-up" d="${smoothPath(seg)}"/>`),
      ...downSegs.map((seg) => `<path class="stats-line-down" d="${smoothPath(seg)}"/>`),
    ].join("");

    return {
      html: `<svg class="stats-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
        <line class="stats-baseline" x1="0" y1="${zeroY}" x2="100" y2="${zeroY}"/>
        ${areas}${lines}
      </svg>`,
      points, zeroY, maxAbs, top, bottom,
    };
  }

  // binds hover-crosshair behavior to a rendered stats-chart-box; call after each render() that
  // includes the chart. `getPoints` should return the same `points` array chartSvgHTML produced.
  function bindChartHover(boxSelector, chartData) {
    const box = document.querySelector(boxSelector);
    if (!box || !chartData || !chartData.points || chartData.points.length < 2) return;
    let lineEl = box.querySelector(".stats-hover-line");
    let dotEl = box.querySelector(".stats-hover-dot");
    let tipEl = box.querySelector(".stats-hover-tooltip");
    if (!lineEl) { lineEl = document.createElement("div"); lineEl.className = "stats-hover-line"; box.appendChild(lineEl); }
    if (!dotEl) { dotEl = document.createElement("div"); dotEl.className = "stats-hover-dot"; box.appendChild(dotEl); }
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "stats-hover-tooltip"; box.appendChild(tipEl); }

    const points = chartData.points;
    function update(clientX) {
      const rect = box.getBoundingClientRect();
      const relX = clampNum(((clientX - rect.left) / rect.width) * 100, 0, 100);
      // find nearest point by x
      let nearest = points[0], bestDist = Infinity;
      for (const p of points) { const d = Math.abs(p.x - relX); if (d < bestDist) { bestDist = d; nearest = p; } }
      const pxX = (nearest.x / 100) * rect.width;
      const pxY = (nearest.y / 100) * rect.height;
      lineEl.style.left = pxX + "px";
      lineEl.style.display = "block";
      dotEl.style.left = pxX + "px";
      dotEl.style.top = pxY + "px";
      dotEl.className = "stats-hover-dot " + (nearest.value >= 0 ? "up" : "down");
      dotEl.style.display = "block";
      tipEl.style.left = pxX + "px";
      tipEl.style.top = pxY + "px";
      tipEl.textContent = (nearest.value >= 0 ? "+$" : "-$") + Math.abs(nearest.value).toFixed(2);
      tipEl.style.display = "block";
    }
    function hide() {
      lineEl.style.display = "none";
      dotEl.style.display = "none";
      tipEl.style.display = "none";
    }
    box.onmousemove = (e) => update(e.clientX);
    box.onmouseleave = hide;
  }

  // ---------- shared "Live Stats" popover ----------
  // One implementation reused by every game page (matches what used to be Keno-only): a
  // draggable panel with a per-game filter dropdown ("All" + every game with bet history),
  // a reset button that wipes the bet log, a profit total, wagered/wins/losses, and the
  // equity-curve chart. Callers keep these fields on their own `state` object:
  //   statsOpen, statsGame ("all" by default), statsGameDropdownOpen, statsDrag, statsPos
  // and call Shell.statsPanelHTML(state, gameId, gameName) inside render(), then
  // Shell.bindStatsPanel(state, render) inside their bind() function.
  // Built lazily (not at module-load time) because shell.js is loaded before games.js on
  // every page, so window.GAME_CATALOG isn't populated yet when this file first runs.
  function knownGameIdsSet() { return new Set((Array.isArray(window.GAME_CATALOG) ? window.GAME_CATALOG : []).map((g) => g.id)); }
  function statsGameNames() { return Object.fromEntries((Array.isArray(window.GAME_CATALOG) ? window.GAME_CATALOG : []).map((g) => [g.id, g.name])); }

  function statsFilteredBetLog(game) {
    const known = knownGameIdsSet();
    let log = getBetLog().filter((b) => known.has(b.game));
    if (!log.length) return [];
    if (!game || game === "all") return log;
    // filter by game
    log = log.filter((b) => b.game === game);
    // apply reset: skip entries before reset time
    const resetTime = getResetTime(game);
    if (resetTime) {
      log = log.filter((b) => b.time >= resetTime);
    }
    return log;
  }

  function statsPlayedGamesList() {
    const known = knownGameIdsSet();
    const seen = new Set(getBetLog().map((b) => b.game).filter((g) => known.has(g)));
    return Array.from(seen);
  }

  function statsPanelHTML(state, gameId, gameName) {
    if (!state.statsOpen) return "";
    const played = statsPlayedGamesList();
    const log = statsFilteredBetLog(state.statsGame || "all");
    const rangeProfit = log.reduce((sum, b) => sum + b.profit, 0);
    const rangeWagered = log.reduce((sum, b) => sum + b.bet, 0);
    const rangeWins = log.filter((b) => b.won).length;
    const rangeLosses = log.filter((b) => !b.won).length;
    const chart = chartSvgHTML(log);
    window.__njLastChart = chart;
    const gameNames = statsGameNames();
    const currentLabel = (!state.statsGame || state.statsGame === "all") ? "All" : (gameNames[state.statsGame] || state.statsGame);
    return `<div class="stats-panel ${state.statsDrag ? "dragging" : ""}" data-stats-popover style="${state.statsPos ? `left:${state.statsPos.left}px; top:${state.statsPos.top}px;` : "left:40px; top:80px;"}">
      <div class="stats-head" data-stats-drag-handle>
        <span>Live Stats — ${gameName}</span>
        <div class="stats-head-actions">
          <button class="stats-reset hover-tip" data-hover-tip="Reset graph" data-stats-reset>${svg("rotate")}</button>
          <button class="stats-close" data-stats-close>${svg("x")}</button>
        </div>
      </div>
      <div class="stats-game-dropdown">
        <button class="stats-game-toggle" data-stats-game-toggle>${currentLabel}${svg("chevronDown")}</button>
        ${state.statsGameDropdownOpen ? `
        <div class="stats-game-menu">
          <button class="${(!state.statsGame || state.statsGame === "all") ? "active" : ""}" data-stats-game="all">All</button>
          ${played.map((g) => `<button class="${state.statsGame === g ? "active" : ""}" data-stats-game="${g}">${gameNames[g] || g}</button>`).join("")}
        </div>` : ""}
      </div>
      <div class="stats-profit ${rangeProfit >= 0 ? "positive" : "negative"}">${rangeProfit >= 0 ? "+$" : "-$"}${Math.abs(rangeProfit).toFixed(2)}</div>
      <div class="stats-grid">
        <div><span>Wagered</span><strong>$${rangeWagered.toFixed(2)}</strong></div>
        <div><span>Wins</span><strong>${rangeWins}</strong></div>
        <div><span>Losses</span><strong>${rangeLosses}</strong></div>
      </div>
      <div class="stats-chart-box" data-stats-chart-box>${chart.html}</div>
    </div>`;
  }

  // Wires up every control inside the panel above, plus the drag handle. `render` is the
  // caller's own render function (called after any state change so the panel repaints).
  function bindStatsPanel(state, render) {
    if (!state.statsOpen) return;
    if (state.statsGame === undefined) state.statsGame = "all";

    document.querySelector("[data-stats-close]")?.addEventListener("click", (e) => { e.stopPropagation(); state.statsOpen = false; render(); });
    document.querySelector("[data-stats-reset]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      const gameFilter = state.statsGame || "all";
      if (gameFilter === "all") {
        Shell.resetBetLog();   // clear all entries
      } else {
        Shell.setGameReset(gameFilter);   // store reset timestamp for this game
      }
      render();
      Shell.notify("Live stats graph reset.");
    });
    document.querySelector("[data-stats-game-toggle]")?.addEventListener("click", (e) => { e.stopPropagation(); state.statsGameDropdownOpen = !state.statsGameDropdownOpen; render(); });
    document.querySelectorAll("[data-stats-game]").forEach((btn) => btn.onclick = (e) => { e.stopPropagation(); state.statsGame = btn.dataset.statsGame; state.statsGameDropdownOpen = false; render(); });

    const dragHandle = document.querySelector("[data-stats-drag-handle]");
    if (dragHandle) dragHandle.addEventListener("mousedown", (e) => {
      if (e.target.closest("[data-stats-close]") || e.target.closest("[data-stats-reset]")) return;
      const panel = document.querySelector("[data-stats-popover]");
      if (!panel) return;
      const rect = panel.getBoundingClientRect();
      state.statsDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
      panel.classList.add("dragging");
      e.preventDefault();
    });

    if (window.__njLastChart) bindChartHover("[data-stats-chart-box]", window.__njLastChart);
  }

  // One shared mousemove/mouseup pair for dragging the stats panel — safe to call this once
  // per page load; it only acts when `state.statsDrag` on whichever state object is truthy.
  function attachStatsPanelDrag(state, render) {
    window.addEventListener("mousemove", (e) => {
      if (!state.statsDrag) return;
      const panel = document.querySelector("[data-stats-popover]");
      const panelW = panel ? panel.offsetWidth : 360;
      const panelH = panel ? panel.offsetHeight : 300;
      const left = Math.max(8, Math.min(e.clientX - state.statsDrag.offsetX, window.innerWidth - panelW - 8));
      const top = Math.max(8, Math.min(e.clientY - state.statsDrag.offsetY, window.innerHeight - panelH - 8));
      state.statsPos = { left, top };
      if (panel) { panel.style.left = left + "px"; panel.style.top = top + "px"; }
    });
    window.addEventListener("mouseup", () => {
      if (!state.statsDrag) return;
      state.statsDrag = null;
      document.querySelector("[data-stats-popover]")?.classList.remove("dragging");
    });
  }

  // ---------- bet detail modal ("how did this bet play out?") ----------
  // Shown on the Bets page when a row is clicked. `bet` is a record from getBetLog();
  // bet.detail (optional) is a small per-game snapshot written by the game at settle time —
  // see each game's addBetEntry call for its shape. Games that don't attach a `detail` (or
  // whose type isn't recognized) fall back to the plain multiplier/payout box.
  function betDetailBoardHTML(bet) {
    const d = bet.detail;
    if (!d) return "";
    const escAttr = (s) => String(s).replace(/"/g, "&quot;");

    if (d.type === "grid") {
      // Mines style: cashing out (or busting) reveals the WHOLE board, same as Rainbet — every
      // gem and mine location is shown, with the tile the player actually clicked highlighted.
      const cols = d.cols || Math.ceil(Math.sqrt((d.cells || []).length)) || 5;
      return `<div class="betdetail-grid" style="grid-template-columns:repeat(${cols},1fr)">
        ${(d.cells || []).map((c) => {
          const cls = ["betdetail-cell"];
          if (c.state === "safe") cls.push("safe");
          else if (c.state === "hit") cls.push("hit");
          if (c.picked) cls.push("picked");
          const icon = c.state === "safe" ? "◆" : c.state === "hit" ? "✕" : "";
          return `<div class="${cls.join(" ")}">${icon}</div>`;
        }).join("")}
      </div>`;
    }

    if (d.type === "rows") {
      // Dragon Tower: the tile(s) the player actually clicked show full-bright (last one
      // highlighted); rows ABOVE the highest row they reached show revealed but dimmed (never
      // played, so shown for reference only); everything else is fully hidden.
      const rows = (d.rows || []).slice().reverse();
      return `<div class="betdetail-rows">
        ${rows.map((row) => `<div class="betdetail-row">
          ${row.map((c) => {
            const cls = ["betdetail-cell", "small"];
            if (!c.wasRevealed) { cls.push("empty"); return `<div class="${cls.join(" ")}"></div>`; }
            if (c.state === "safe") cls.push("safe");
            else if (c.state === "hit") cls.push("hit");
            if (c.dim) cls.push("dim");
            if (c.picked) cls.push("picked");
            const icon = c.state === "safe" ? "◆" : c.state === "hit" ? "✕" : "";
            return `<div class="${cls.join(" ")}">${icon}</div>`;
          }).join("")}
        </div>`).join("")}
      </div>`;
    }

    if (d.type === "dice") {
      return `<div class="betdetail-dice">
        <div class="betdetail-dice-roll">${(d.roll || 0).toFixed(2)}</div>
        <div class="betdetail-dice-sub">${(d.mode || "").toUpperCase()} ${d.target != null ? d.target.toFixed(2) : ""}</div>
      </div>`;
    }

    if (d.type === "keno") {
      const drawnSet = new Set(d.drawn || []);
      const picksSet = new Set(d.picks || []);
      const total = d.total || 40;
      return `<div class="betdetail-keno">
        ${Array.from({ length: total }, (_, i) => i + 1).map((n) => {
          const isPick = picksSet.has(n);
          const isDrawn = drawnSet.has(n);
          const cls = ["betdetail-keno-cell"];
          if (isPick && isDrawn) cls.push("hit");
          else if (isPick) cls.push("picked");
          else if (isDrawn) cls.push("drawn");
          return `<div class="${cls.join(" ")}">${n}</div>`;
        }).join("")}
      </div>`;
    }

    if (d.type === "cards") {
      // Blackjack style: one or more hands, each an array of card labels (e.g. "K of Spades").
      return `<div class="betdetail-cards">
        ${(d.hands || []).map((h) => `<div class="betdetail-hand">
          <div class="betdetail-hand-label">${h.label || ""}${h.total != null ? ` · ${h.total}` : ""}</div>
          <div class="betdetail-hand-cards">${(h.cards || []).map((c) => `<div class="betdetail-card${c.red ? " red" : ""}">${c.label}</div>`).join("")}</div>
        </div>`).join("")}
      </div>`;
    }

    return "";
  }

  function betDetailModalHTML(bet, gameName) {
    if (!bet) return "";
    const payout = bet.won ? (bet.bet + bet.profit) : 0;
    const mult = bet.bet > 0 ? (payout / bet.bet) : 0;
    const d = bet.detail;
    const hasBoard = d && (d.type === "grid" || d.type === "rows" || d.type === "dice" || d.type === "keno" || d.type === "cards");
    const board = betDetailBoardHTML(bet);
    const dt = new Date(bet.time);
    const dateLabel = dt.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) + " at " + dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

    return `
      <div class="shell-modal-box betdetail-box">
        <div class="shell-modal-head">
          <h3>${svg("spark")} Bet</h3>
          <button class="shell-modal-close" data-betdetail-close aria-label="Close">${svg("x")}</button>
        </div>
        <div class="betdetail-summary">
          <div class="betdetail-game">${gameName || bet.game}</div>
          <div class="betdetail-date">${dateLabel}</div>
        </div>
        <div class="betdetail-stats">
          <div><span>Amount</span><strong>${fmtMoney(bet.bet || 0)}</strong></div>
          <div><span>Multiplier</span><strong>${mult.toFixed(2)}x</strong></div>
          <div><span>Payout</span><strong class="${payout > 0 ? "win" : ""}">${fmtMoney(payout)}</strong></div>
        </div>
        <div class="betdetail-board">
          ${hasBoard ? board : `<div class="betdetail-mult"><div class="betdetail-mult-value">${mult.toFixed(2)}x</div><div class="betdetail-mult-label">${payout > 0 ? "Win" : "Loss"} · ${fmtMoney(payout)}</div></div>`}
        </div>
      </div>`;
  }

  function openBetDetailModal(bet, gameName) {
    closeAllOverlays();
    const wrap = document.createElement("div");
    wrap.className = "shell-modal-overlay";
    wrap.setAttribute("data-betdetail-overlay", "");
    wrap.innerHTML = betDetailModalHTML(bet, gameName);
    document.body.appendChild(wrap);
    const close = () => wrap.remove();
    wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
    wrap.querySelector("[data-betdetail-close]")?.addEventListener("click", close);
  }

  return {
    mount, getBalance, setBalance, addBalance, resetBalance, resetAllProgress, getFavorites, setFavorites, toggleFavorite, notify, fmtMoney, svg, gameArtInner,
    getCashBalance, setCashBalance, addCashBalance, resetCashBalance,
    getRewardBalance, setRewardBalance, addRewardBalance, resetRewardBalance,
    getActiveCurrency, setActiveCurrency, currencyCoinHTML,
    getRewardLockState, rewardGoalMet, rewardConvertibleNow, convertRewardToCash,
    openCurrencyDropdown, openExchangeModal,
    MIN_BET, isBelowMinBet,
    statsPanelHTML, bindStatsPanel, attachStatsPanelDrag,
    betDetailModalHTML, openBetDetailModal,
    getBetLog, setBetLog, addBetEntry, resetBetLog, getLifetimeWagered, addLifetimeWagered, playChipSound, playDiceRollSound, playWinDing, chartSvgHTML, bindChartHover, getRecentPlayerWins,
    saveActiveRound, loadActiveRound, clearActiveRound,
    openVaultModal, openEarnModal, openSearchModal, openProfileModal, openRewardsDropdown, openSettingsModal, openClaimResultModal,
    getNotifications, addNotification, unreadNotificationCount,
    getRecentSearches, addRecentSearch,
    getVaultBalance, setVaultBalance,
    setGameReset,
    getPlayerProfile, setPlayerProfile, avatarInitials, fmtMemberSince,
    getAvatarImage, setAvatarImage, avatarContentHTML,
    isAnimationsDisabled, setAnimationsDisabled,
    isLoggedOut, logout, loginBackIn,
    isAppearOffline, setAppearOffline,
    RANK_TRACKS, RANK_TIERS, RANK_TOTAL_TIERS, RANK_MAX_WAGER,
    rankStats, rankTierThreshold, rankTierTrack, rankTierRoman, rankTierLabel,
    rankColorFor, rankTextStyle,
    REWARD_AMOUNTS, getClaimTotals, claimRemaining, claimReward, fmtCountdown, fmtClock, getBoostRemaining,
    getRakebackAvailable, claimRakeback,
    EARN_UPGRADES, getEarnState, earnTick, earnClick, earnBuyUpgrade, earnClaimPassive,
    earnClickValue, earnPassiveRate, earnUpgradeCost, earnUpgradeMaxed,
    RAFFLE_WAGER_STEP, RAFFLE_TIERS, raffleSpinsAvailable, spinRaffleWheel, raffleOddsForRank,
    CASE_UPGRADES, CASE_UPGRADE_MAX, getCaseUpgrades, caseUpgradeCost, caseUpgradeMaxed, buyCaseUpgrade,
    caseSpinDurationMs,
    LEGENDARY_TIER, EXOTIC_TIER, LEGENDARY_CASE_COST, EXOTIC_CASE_COST, COMBINE_TIERS, EXOTIC_TIERS,
    combineOddsForRank, exoticOddsForRank,
    getLegendaryCasesOwned, getExoticCasesOwned, convertToLegendaryCase, convertToExoticCase,
    convertAllToLegendaryCases, convertAllToExoticCases,
    canOpenLegendaryCase, openLegendaryCase, canOpenExoticCase, openExoticCase,
    CASE_BATCH_BASE, CASE_BATCH_MAX, CASE_BATCH_UPGRADE_COST, hasCaseBatchUpgrade, caseBatchMax, buyCaseBatchUpgrade,
    exportAccountCode, importAccountCode,
    registerAccount, loginToAccount, decodeSyncCodeForMigration, persistActiveAccount, getActiveAccountUsername,
    switchAccount, hasOtherAccounts, switchToKnownAccount, changePassword, changeUsername, removeSavedAccount,
    isDeveloper, isDeveloperUnlocked, isDeveloperEnabled, setDeveloperEnabled, tryUnlockDeveloper, devSetBalance, devSetRank, devMaxRank, devMaxIncremental, devGrantCases,
    redeemPromoCode, devRevertChanges, hasDevSnapshot,
    getRailDropdownState, setRailDropdownState, gameSidebarIcon,
    BM_CATALOG, getBlackMarketState, blackMarketPrice, buyBlackMarketItem, getInventory, getActiveBoosts, activateBoost, activeBoostPct,
    bindOverlayOutsideClose,
  };
})();