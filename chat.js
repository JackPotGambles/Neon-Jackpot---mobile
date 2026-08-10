/*
  CHAT.JS — live chat + presence, backed by Firebase Realtime Database
  ----------------------------------------------------------------------
  Adds a slide-out chat panel (button in the top-right of the title bar,
  next to the sidebar-collapse pattern) that lets everyone playing see
  who else is online and talk in real time, without running a server.

  SETUP (see the instructions you were given for the Firebase Console
  steps) — once you have your firebaseConfig object, paste it into the
  FIREBASE_CONFIG constant below. That's the only thing you need to edit.

  Include this AFTER shell.js and the Firebase SDK scripts, before your
  page's own script:
    <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js"></script>
    <script src="https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js"></script>
    <script src="./shell.js"></script>
    <script src="./chat.js"></script>

  Then call Chat.mount() once, right after Shell.mount() on every page.
*/
window.Chat = (() => {
  "use strict";

  // ---------------------------------------------------------------------
  // 1) PASTE YOUR FIREBASE CONFIG HERE
  // ---------------------------------------------------------------------
  const FIREBASE_CONFIG = {
    apiKey: "AIzaSyBskecxdRn4bd9hTsysB5kxQUu0SPiriBc",
    authDomain: "neon-jackpot-264cb.firebaseapp.com",
    projectId: "neon-jackpot-264cb",
    databaseURL: "https://neon-jackpot-264cb-default-rtdb.firebaseio.com",
    storageBucket: "neon-jackpot-264cb.firebasestorage.app",
    messagingSenderId: "9058066447",
    appId: "1:9058066447:web:7900b7bd62b28187d1837a"
  };

  const CHAT_PANEL_OPEN_KEY = "nj_chat_panel_open";
  const LAST_SEEN_MSG_KEY = "nj_chat_last_seen_msg";
  const CHAT_PANEL_POS_KEY = "nj_chat_panel_pos";   // { left, top }
  const CHAT_PANEL_SIZE_KEY = "nj_chat_panel_size"; // { width, height }
  const CHAT_TEXT_SIZE_KEY = "nj_chat_text_size";   // 0-3, index into CHAT_TEXT_SIZES
  const CHAT_TEXT_SIZES = ["12px", "13.5px", "15px", "17px"];
  const CHAT_NAME_COLOR_KEY = "nj_chat_color"; // reuse the player's own avatar color for their chat name
  const PRESENCE_STALE_MS = 90000; // consider someone "offline" if their heartbeat is older than this
  const HEARTBEAT_MS = 45000;
  const MAX_MESSAGES = 40; // trim how many messages we keep/display

  // Local ledger of direct-gift IDs this save has already credited, so a reconnect / duplicate
  // child_added event (e.g. two tabs open) can never double-pay the same gift. Mirrors the
  // REDEEMED_KEY pattern in gifts.js — same reasoning, different transport.
  const DIRECT_GIFT_PROCESSED_KEY = "nj_direct_gift_processed";

  // ---------------------------------------------------------------------
  // VERSION LOCK — bump CURRENT_VERSION here every time you hand out new
  // files, then publish the same value (plus a download link) to Firebase
  // — either via the Developer Tools panel in-app (Live Update section,
  // requires developer mode) or by calling Chat.setLatestVersion(...) /
  // Chat.setDownloadUrl(...) from the console.
  //
  // Anyone whose local CURRENT_VERSION doesn't match what's published gets
  // a full-screen lockout overlay they cannot dismiss or play through —
  // only a download link out. This applies to someone who was offline when
  // you published too, the moment they next open the page and connect.
  // This does NOT auto-update files (everyone runs local copies handed out
  // manually) — it only gates play until they've grabbed the new ones.
  // Compared for plain equality, not ordering, so any distinct string works.
  // ---------------------------------------------------------------------
  const CURRENT_VERSION = "1";

  let db = null;
  let ready = false;
  let unsubscribeChat = null;
  let unsubscribePresence = null;
  let heartbeatTimer = null;
  let staleCheckTimer = null;
  let messages = [];
  let presenceMap = {}; // playerId -> { name, color, lastSeen, rankLabel, rankTrack, wagered }
  let panelBound = false;
  let panelPoppedOut = false;
  let profileClicksBound = false;
  let unsubscribeDirectGifts = null;

  function isConfigured() {
    return !FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey.indexOf("PASTE_") === 0
      ? false
      : true;
  }

  function initFirebase() {
    if (ready) return true;
    if (!isConfigured()) return false;
    if (typeof firebase === "undefined") {
      console.warn("Chat: Firebase SDK scripts not loaded — add the firebase-app-compat.js and firebase-database-compat.js script tags before chat.js.");
      return false;
    }
    try {
      if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
      db = firebase.database();
      ready = true;
      return true;
    } catch (err) {
      console.warn("Chat: failed to initialize Firebase.", err);
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // panel open/closed state persists across page navigations, same
  // pattern as the sidebar-collapse state in shell.js
  // ---------------------------------------------------------------------
  function isPanelOpen() { return localStorage.getItem(CHAT_PANEL_OPEN_KEY) === "1"; }
  function setPanelOpen(open) { localStorage.setItem(CHAT_PANEL_OPEN_KEY, open ? "1" : "0"); }
  const CHAT_PANEL_POPPED_KEY = "nj_chat_panel_popped";
  function isPanelPoppedOut() { return localStorage.getItem(CHAT_PANEL_POPPED_KEY) === "1"; }
  function setPanelPoppedOut(v) { localStorage.setItem(CHAT_PANEL_POPPED_KEY, v ? "1" : "0"); }

  function myChatColor() {
    let c = localStorage.getItem(CHAT_NAME_COLOR_KEY);
    if (c) return c;
    c = Shell.getPlayerProfile().avatarColor || "#5cffe7";
    localStorage.setItem(CHAT_NAME_COLOR_KEY, c);
    return c;
  }

  // ---------------------------------------------------------------------
  // PRESENCE — write a heartbeat under presence/{playerId} every few
  // seconds, and use onDisconnect() so Firebase itself removes it the
  // instant the tab/browser closes (even on a crash, not just a clean
  // close). Anyone whose heartbeat is older than PRESENCE_STALE_MS is
  // treated as offline even if their node is still lingering.
  // ---------------------------------------------------------------------
  function startPresence() {
    if (!ready) return;
    const player = Shell.getPlayerProfile();
    const myRef = db.ref("presence/" + player.id);

    // Rank/wagered are included so a player's PUBLIC profile card (see openProfileCard below)
    // can show something for anyone currently online, without needing a separate lookup. This
    // is read-only, non-sensitive info the player already sees about themselves everywhere else.
    const payload = () => {
      const rank = Shell.rankStats();
      return {
        name: player.name,
        color: player.avatarColor || myChatColor(),
        lastSeen: firebase.database.ServerValue.TIMESTAMP,
        rankLabel: rank.label,
        rankTrack: rank.track,
        wagered: Shell.getLifetimeWagered(),
      };
    };

    myRef.onDisconnect().remove();

    // Only actually write presence if the player isn't currently "appearing offline".
    function syncPresence() {
      if (Shell.isAppearOffline()) {
        myRef.remove();
      } else {
        myRef.set(payload());
      }
    }
    syncPresence();

    clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => { if (ready) syncPresence(); }, HEARTBEAT_MS);

    // React immediately when the dev panel toggle changes, instead of waiting up to
    // HEARTBEAT_MS for the next tick — flipping the switch should hide/show you right away.
    document.addEventListener("nj:appearoffline", syncPresence);

    unsubscribePresence = db.ref("presence").on("value", (snap) => {
      presenceMap = snap.val() || {};
      renderPresenceList();
    });

    clearInterval(staleCheckTimer);
    staleCheckTimer = setInterval(renderPresenceList, 5000);
  }

  function onlinePlayers() {
    const now = Date.now();
    return Object.entries(presenceMap)
      .map(([id, p]) => ({ id, ...p }))
      .filter((p) => p.lastSeen && (now - p.lastSeen) < PRESENCE_STALE_MS)
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }

  // ---------------------------------------------------------------------
  // CHAT — a simple append-only list under /chat, capped client-side to
  // the most recent MAX_MESSAGES. We only ever query the last 100 from
  // Firebase itself (limitToLast) to keep the initial load light.
  // ---------------------------------------------------------------------
  let lastSeenMsgKey = null;
  let chatSyncPrimed = false; // becomes true after the very first snapshot, so we never ding for old history on page load

  function startChatSync() {
    if (!ready) return;
    const chatRef = db.ref("chat").limitToLast(40);
    unsubscribeChat = chatRef.on("value", (snap) => {
      const val = snap.val() || {};
      messages = Object.entries(val)
        .map(([msgKey, m]) => ({ msgKey, ...m }))
        .sort((a, b) => (a.time || 0) - (b.time || 0))
        .slice(-MAX_MESSAGES);

      const newest = messages[messages.length - 1];
      const myId = Shell.getPlayerProfile().id;
      if (chatSyncPrimed && newest && newest.msgKey !== lastSeenMsgKey && newest.id !== myId) {
        if (!isPanelOpen()) playNewMessageTone();
      }
      if (newest) lastSeenMsgKey = newest.msgKey;
      chatSyncPrimed = true;
      localStorage.setItem(LAST_SEEN_MSG_KEY, lastSeenMsgKey || "");

      renderMessages();
    });
  }

  // ---------------------------------------------------------------------
  // DEV CHAT COMMANDS — only usable by accounts with Shell.isDeveloper()
  // true. Typed into the chat input like a normal message; never sent to
  // Firebase as a chat message, always intercepted client-side first.
  // ---------------------------------------------------------------------
  function isDevCommand(text) {
    return text.trim().startsWith("/");
  }

  function runDevCommand(raw) {
    const text = raw.trim();
    const [cmd, ...args] = text.slice(1).split(/\s+/);

    if (!Shell.isDeveloper()) {
      Shell.notify("That's a developer-only command.");
      return;
    }

    switch ((cmd || "").toLowerCase()) {
      case "clear":
      case "clearchat":
        if (!ready) { Shell.notify("Chat isn't connected."); return; }
        db.ref("chat").remove().then(() => {
          Shell.notify("Chat cleared for everyone.");
        }).catch(() => Shell.notify("Couldn't clear chat — check permissions."));
        break;

      case "kick": {
        // Removes a player's presence entry (makes them show offline). Does not
        // actually disconnect them — it's cosmetic, since there's no real server
        // session to terminate.
        const targetId = (args[0] || "").toUpperCase();
        if (!targetId || !ready) { Shell.notify("Usage: /kick PLAYERID"); return; }
        db.ref("presence/" + targetId).remove();
        Shell.notify(`Removed ${targetId} from the online list.`);
        break;
      }

      case "announce": {
        const msg = args.join(" ");
        if (!msg || !ready) { Shell.notify("Usage: /announce your message"); return; }
        db.ref("chat").push({
          id: "", // no id -> not clickable as a profile, reads as a system message
          name: "📢 Announcement",
          color: "#ffcf7d",
          text: msg.slice(0, 500),
          time: firebase.database.ServerValue.TIMESTAMP,
        });
        break;
      }

      default:
        Shell.notify(`Unknown command: /${cmd}`);
    }
  }

  // ---------------------------------------------------------------------
  // SLASH-COMMAND GHOST TEXT — developer-only autocomplete hint shown
  // behind what's typed, e.g. typing "/cl" shows "/clear" ghosted in.
  // Never shown to non-developers, even if they happen to type "/".
  // ---------------------------------------------------------------------
  const DEV_COMMANDS = ["/clear", "/clearchat", "/kick", "/announce"];
  function suggestCommand(typed) {
    if (!typed.startsWith("/") || typed.length < 1) return "";
    const match = DEV_COMMANDS.find((c) => c.startsWith(typed.toLowerCase()));
    return match || "";
  }
  function updateGhostText(inputVal) {
    const ghostEl = document.querySelector("[data-chat-input-ghost]");
    if (!ghostEl) return;
    if (!Shell.isDeveloper() || !inputVal) { ghostEl.textContent = ""; return; }
    const suggestion = suggestCommand(inputVal);
    if (!suggestion || suggestion === inputVal.toLowerCase()) { ghostEl.textContent = ""; return; }
    // Render the typed part invisibly (so spacing lines up) then the remainder ghosted.
    ghostEl.innerHTML = `<span style="visibility:hidden;">${escapeHTML(inputVal)}</span><span class="chat-ghost-suffix">${escapeHTML(suggestion.slice(inputVal.length))}</span>`;
  }

  function sendMessage(text) {
    const clean = (text || "").trim();
    if (!clean || !ready) return;
    if (isDevCommand(clean)) { runDevCommand(clean); return; }
    const player = Shell.getPlayerProfile();
    db.ref("chat").push({
      id: player.id, // lets a click on this message's name open that player's profile card
      name: player.name,
      color: player.avatarColor || myChatColor(),
      text: clean.slice(0, 500),
      time: firebase.database.ServerValue.TIMESTAMP,
    });
  }

  // ---------------------------------------------------------------------
  // UI — a slide-out panel anchored to the top-right, toggled by a button
  // placed in the topbar's action cluster (next to the other icon boxes),
  // mirroring the sidebar's expand/collapse affordance on the left.
  // ---------------------------------------------------------------------
  function getPanelPos() {
    try { return JSON.parse(localStorage.getItem(CHAT_PANEL_POS_KEY)) || null; } catch { return null; }
  }
  function setPanelPos(pos) { localStorage.setItem(CHAT_PANEL_POS_KEY, JSON.stringify(pos)); }
  function getPanelSize() {
    try { return JSON.parse(localStorage.getItem(CHAT_PANEL_SIZE_KEY)) || null; } catch { return null; }
  }
  function setPanelSize(size) { localStorage.setItem(CHAT_PANEL_SIZE_KEY, JSON.stringify(size)); }

  function getChatTextSizeIndex() {
    const v = parseInt(localStorage.getItem(CHAT_TEXT_SIZE_KEY), 10);
    return (v >= 0 && v <= 3) ? v : 1; // default = index 1 (13.5px, close to current default)
  }
  function setChatTextSizeIndex(i) {
    localStorage.setItem(CHAT_TEXT_SIZE_KEY, String(i));
    applyChatTextSize();
  }
  function applyChatTextSize() {
    const size = CHAT_TEXT_SIZES[getChatTextSizeIndex()];
    document.querySelectorAll(".chat-messages").forEach((el) => el.style.setProperty("--chat-text-size", size));
  }

  function panelHTML() {
    const open = isPanelOpen();
    const popped = isPanelPoppedOut();
    const pos = popped ? getPanelPos() : null;
    const size = popped ? getPanelSize() : null;
    let posStyle = "";
    if (popped) {
      if (pos) {
        posStyle = `left:${pos.left}px; top:${pos.top}px; right:auto;`;
      } else {
        const left = Math.max(20, Math.round(window.innerWidth / 2 - 170));
        const top = Math.max(20, Math.round(window.innerHeight / 2 - 260));
        posStyle = `left:${left}px; top:${top}px; right:auto;`;
      }
    }
    const sizeStyle = popped && size ? `width:${size.width}px; height:${size.height}px;` : "";
    return `<aside class="chat-panel ${open ? "open" : ""} ${popped ? "popped-out" : ""}" data-chat-panel style="${posStyle}${sizeStyle}">
      <div class="chat-panel-head" data-chat-drag-handle>
        <span class="chat-panel-title">${Shell.svg("sparkles")} Friends Chat</span>
        <button class="chat-panel-close hover-tip" data-hover-tip="Close chat" data-chat-close aria-label="Close chat">${Shell.svg("x")}</button>
      </div>
      <div class="chat-online-row" data-chat-online></div>
      <div class="chat-messages" data-chat-messages></div>
      <div class="chat-toolbar-row">
        <button class="chat-toolbar-btn hover-tip" data-hover-tip="Chat settings" data-chat-settings-btn aria-label="Chat settings">${Shell.svg("settings")}</button>
        <button class="chat-toolbar-btn hover-tip" data-hover-tip="Customize your rank icon" data-chat-customize-btn aria-label="Customize rank icon">${Shell.svg("edit")}</button>
        <button class="chat-toolbar-btn hover-tip" data-hover-tip="${popped ? "Dock chat" : "Popout chat"}" data-chat-popout aria-label="Popout chat">${Shell.svg("grid")}</button>
      </div>
      <div class="chat-input-row">
        <div class="chat-input-ghost-wrap">
          <div class="chat-input-ghost" data-chat-input-ghost></div>
          <input type="text" maxlength="500" placeholder="${isConfigured() ? "Message your friends…" : "Chat isn't set up yet — add your Firebase config"}" data-chat-input ${isConfigured() ? "" : "disabled"}>
        </div>
        <button class="chat-send-btn" data-chat-send ${isConfigured() ? "" : "disabled"} aria-label="Send">${Shell.svg("bolt")}</button>
      </div>
      <div class="chat-resize-handle" data-chat-resize-handle></div>
    </aside>`;
  }

  function toggleBtnHTML() {
    const open = isPanelOpen();
    return `<button class="icon-button chat-toggle-btn hover-tip ${open ? "active" : ""}" data-hover-tip="${open ? "Close chat" : "Open chat"}" data-chat-toggle aria-label="Toggle chat">
      ${Shell.svg("sparkles")}
      <span class="chat-unread-dot" data-chat-unread-dot style="display:none;"></span>
    </button>`;
  }

  function escapeHTML(s) {
    return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function fmtTime(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ---------------------------------------------------------------------
  // Subtle "new message" notification tone — plays once whenever a new
  // incoming message arrives while the panel is closed. Deliberately soft
  // and short, not a loud alert sound.
  // ---------------------------------------------------------------------
  let chatAudioCtx = null;
  function playNewMessageTone() {
    try {
      if (!chatAudioCtx) chatAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = chatAudioCtx;
      const now = ctx.currentTime;
      [ { freq: 920, delay: 0 }, { freq: 1180, delay: 0.09 } ].forEach(({ freq, delay }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(920, now);
        osc.frequency.exponentialRampToValueAtTime(700, now + 0.12);
        gain.gain.setValueAtTime(0.001, now);
        gain.gain.linearRampToValueAtTime(0.09, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.24);
      });
    } catch {}
  }

  // Returns the CURRENT name/color for whoever sent a message, so renaming/recoloring your
  // profile updates every past message you've sent instead of leaving old ones stuck showing
  // your old name forever. Falls back to what was stored on the message itself only if we
  // have no better info (e.g. the sender has never been seen online since we connected).
  function liveNameAndColor(m) {
    if (m.id) {
      if (m.id === Shell.getPlayerProfile().id) {
        const me = Shell.getPlayerProfile();
        const myRank = Shell.rankStats();
        const override = getChatIconOverride();
        const rankTrack = override === "none" ? null : (override || myRank.track);
        return { name: me.name, color: me.avatarColor || myChatColor(), rankTrack };
      }
      const p = presenceMap[m.id];
      if (p && p.name) return { name: p.name, color: p.color || "#5cffe7", rankTrack: p.rankTrack };
    }
    return { name: m.name || "Player", color: m.color || "#5cffe7", rankTrack: null };
  }

  // Small diamond icon colored per rank track, shown to the left of a name in chat.
  // "Unranked" (or missing track) renders nothing.
  function rankIconHTML(track) {
    if (!track || track === "Unranked") return "";
    const c = Shell.rankColorFor(track).color;
    return `<span class="chat-rank-icon" style="color:${c};" title="${track}">${Shell.svg("safe")}</span>`;
  }


  function renderMessages() {
    const box = document.querySelector("[data-chat-messages]");
    if (!box) return;
    const myId = Shell.getPlayerProfile().id;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;

    box.innerHTML = messages.length
      ? messages.map((m) => {
          if (m.giftEvent) {
            return `<div class="chat-gift-announce">${Shell.svg("gift")} <strong>${escapeHTML(m.giftEvent.senderName)}</strong> has gifted <strong>${escapeHTML(m.giftEvent.recipientName)}</strong> ${Shell.fmtMoney(m.giftEvent.amount)}!</div>`;
          }
          const live = liveNameAndColor(m);
          return `<div class="chat-msg">
          ${rankIconHTML(live.rankTrack)}<span class="chat-msg-name${m.id ? " hover-tip" : ""}" ${m.id ? `data-hover-tip="View profile" data-profile-id="${escapeHTML(m.id)}"` : ""} style="color:${live.color};${m.id ? "cursor:pointer;" : ""}">${escapeHTML(live.name)}</span>
          <span class="chat-msg-time">${fmtTime(m.time)}</span>
          <div class="chat-msg-text">${escapeHTML(m.text)}</div>
        </div>`;
        }).join("")
      : `<div class="chat-empty">${isConfigured() ? "No messages yet — say hi!" : "Chat isn't connected. See chat.js for setup."}</div>`;

    if (atBottom) box.scrollTop = box.scrollHeight;

    // unread dot: only show when the panel is closed, the newest message isn't from me,
    // AND we haven't already marked that exact message as seen (persisted across reloads)
    const last = messages[messages.length - 1];
    const seenKey = localStorage.getItem(LAST_SEEN_MSG_KEY) || "";
    const dot = document.querySelector("[data-chat-unread-dot]");
    const isUnread = !!(last && last.id !== Shell.getPlayerProfile().id && last.msgKey !== seenKey);
    if (dot) dot.style.display = (!isPanelOpen() && isUnread) ? "block" : "none";
  }

  function renderPresenceList() {
    const row = document.querySelector("[data-chat-online]");
    if (!row) return;
    const players = onlinePlayers();
    row.innerHTML = `<span class="chat-online-label">${Shell.svg("activity")} ${players.length} online</span>
      <div class="chat-online-avatars">
        ${players.map((p) => `<span class="chat-online-avatar hover-tip" data-hover-tip="${escapeHTML(p.name)}" data-profile-id="${escapeHTML(p.id)}" style="background:${p.color || "#5cffe7"}; cursor:pointer;">${escapeHTML((p.name || "?").slice(0, 1).toUpperCase())}</span>`).join("")}
      </div>`;
  }

  function openPanel() {
    setPanelOpen(true);
    document.querySelector("[data-chat-panel]")?.classList.add("open");
    document.querySelector("[data-chat-toggle]")?.classList.add("active");
    const dot = document.querySelector("[data-chat-unread-dot]");
    if (dot) dot.style.display = "none";
    const last = messages[messages.length - 1];
    if (last) localStorage.setItem(LAST_SEEN_MSG_KEY, last.msgKey);
    document.querySelector("[data-chat-input]")?.focus();
  }
  function closePanel() {
    setPanelOpen(false);
    document.querySelector("[data-chat-panel]")?.classList.remove("open");
    document.querySelector("[data-chat-toggle]")?.classList.remove("active");
  }

  function bindPanel() {
    const toggleBtn = document.querySelector("[data-chat-toggle]");
    if (toggleBtn) toggleBtn.onclick = (e) => {
      e.stopPropagation();
      isPanelOpen() ? closePanel() : openPanel();
    };
    document.querySelector("[data-chat-close]")?.addEventListener("click", closePanel);
    const popoutBtn = document.querySelector("[data-chat-popout]");
    if (popoutBtn) {
      const freshPopoutBtn = popoutBtn.cloneNode(true);
      popoutBtn.replaceWith(freshPopoutBtn);
      freshPopoutBtn.addEventListener("click", () => {
        setPanelPoppedOut(!isPanelPoppedOut());
        const panel = document.querySelector("[data-chat-panel]");
        if (panel) {
          const wasOpen = isPanelOpen();
          panel.outerHTML = panelHTML();
          if (wasOpen) document.querySelector("[data-chat-panel]")?.classList.add("open");
          bindPanel();
          renderMessages();
          renderPresenceList();
        }
      });
    }

    const input = document.querySelector("[data-chat-input]");
    const send = () => {
      if (!input) return;
      sendMessage(input.value);
      input.value = "";
      updateGhostText("");
      input.focus();
    };
    document.querySelector("[data-chat-send]")?.addEventListener("click", send);
    input?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); send(); return; }
      // Tab autocompletes the ghosted suggestion, same convention as most command-line UIs.
      if (e.key === "Tab" && Shell.isDeveloper()) {
        const suggestion = suggestCommand(input.value);
        if (suggestion) { e.preventDefault(); input.value = suggestion + " "; updateGhostText(input.value); }
      }
    });
    input?.addEventListener("input", (e) => updateGhostText(e.target.value));

    bindPanelDragAndResize();

    const settingsBtn = document.querySelector("[data-chat-settings-btn]");
    if (settingsBtn) {
      const freshSettingsBtn = settingsBtn.cloneNode(true);
      settingsBtn.replaceWith(freshSettingsBtn);
      freshSettingsBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleChatSettingsPopover(); });
    }

    const customizeBtn = document.querySelector("[data-chat-customize-btn]");
    if (customizeBtn) {
      const freshCustomizeBtn = customizeBtn.cloneNode(true);
      customizeBtn.replaceWith(freshCustomizeBtn);
      freshCustomizeBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleChatCustomizePopover(); });
    }

    applyChatTextSize();
  }

  // ---------------------------------------------------------------------
  // CHAT SETTINGS POPOVER — currently just text size (4 steps)
  // ---------------------------------------------------------------------
  let chatPopoverOutsideCloser = null;
  function closeChatPopovers() {
    document.querySelector("[data-chat-settings-popover]")?.remove();
    document.querySelector("[data-chat-customize-popover]")?.remove();
    if (chatPopoverOutsideCloser) {
      document.removeEventListener("click", chatPopoverOutsideCloser);
      chatPopoverOutsideCloser = null;
    }
  }
  function toggleChatSettingsPopover() {
    const wasOpen = !!document.querySelector("[data-chat-settings-popover]");
    closeChatPopovers();
    if (wasOpen) return;
    const btn = document.querySelector("[data-chat-settings-btn]");
    if (!btn) return;
    const idx = getChatTextSizeIndex();
    const pop = document.createElement("div");
    pop.className = "chat-toolbar-popover";
    pop.setAttribute("data-chat-settings-popover", "");
    pop.innerHTML = `
      <div class="chat-toolbar-popover-title">Text Size</div>
      <input type="range" min="0" max="3" step="1" value="${idx}" data-chat-textsize-slider>
      <div class="chat-toolbar-popover-labels"><span>A</span><span style="font-size:16px;">A</span></div>
    `;
    btn.parentElement.appendChild(pop);
    pop.querySelector("[data-chat-textsize-slider]").addEventListener("input", (e) => {
      setChatTextSizeIndex(parseInt(e.target.value, 10));
    });
    chatPopoverOutsideCloser = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== btn) closeChatPopovers();
    };
    setTimeout(() => document.addEventListener("click", chatPopoverOutsideCloser), 0);
  }

  // ---------------------------------------------------------------------
  // RANK ICON CUSTOMIZE POPOVER — pick which rank icon (Bronze..Infernal
  // Diamond, or None) shows next to YOUR name in chat. Purely cosmetic —
  // does not change your real rank, only which badge is displayed.
  // ---------------------------------------------------------------------
  const CHAT_ICON_OVERRIDE_KEY = "nj_chat_icon_override"; // one of Shell.RANK_TRACKS, "" (auto/real rank), or "none"
  function getChatIconOverride() {
    return localStorage.getItem(CHAT_ICON_OVERRIDE_KEY) || "";
  }
  function setChatIconOverride(track) {
    localStorage.setItem(CHAT_ICON_OVERRIDE_KEY, track || "");
  }
  function toggleChatCustomizePopover() {
    const wasOpen = !!document.querySelector("[data-chat-customize-popover]");
    closeChatPopovers();
    if (wasOpen) return;
    const btn = document.querySelector("[data-chat-customize-btn]");
    if (!btn) return;
    const current = getChatIconOverride();
    const myTier = Shell.rankStats().tier; // 0 = Unranked, up to RANK_TOTAL_TIERS
    const highestUnlockedIndex = Math.floor((myTier - 1) / Shell.RANK_TIERS); // -1 if tier is 0 (Unranked)
    const unlockedTracks = Shell.RANK_TRACKS.filter((_, i) => i <= highestUnlockedIndex);
    const tracks = ["", ...unlockedTracks, "none"];
    const labelFor = (t) => t === "" ? "Automatic (my real rank)" : t === "none" ? "No icon" : t;
    const pop = document.createElement("div");
    pop.className = "chat-toolbar-popover";
    pop.setAttribute("data-chat-customize-popover", "");
    pop.innerHTML = `
      <div class="chat-toolbar-popover-title">Rank Icon</div>
      <div class="chat-icon-option-list">
        ${tracks.map((t) => {
          const active = t === current;
          const swatch = (t && t !== "none") ? Shell.rankColorFor(t).color : "#55617a";
          return `<button class="chat-icon-option ${active ? "active" : ""}" data-chat-icon-pick="${t}">
            <span class="chat-icon-option-dot" style="background:${swatch};"></span>
            <span>${labelFor(t)}</span>
          </button>`;
        }).join("")}
      </div>
    `;
    btn.parentElement.appendChild(pop);
    pop.querySelectorAll("[data-chat-icon-pick]").forEach((b) => b.onclick = () => {
      setChatIconOverride(b.dataset.chatIconPick);
      closeChatPopovers();
      renderMessages();
    });
    chatPopoverOutsideCloser = (ev) => {
      if (!pop.contains(ev.target) && ev.target !== btn) closeChatPopovers();
    };
    setTimeout(() => document.addEventListener("click", chatPopoverOutsideCloser), 0);
  }

  // ---------------------------------------------------------------------
  // DRAG + RESIZE — same pattern as shell.js's floating developer tools
  // panel: mousedown on the header starts a drag, mousedown on the corner
  // handle starts a resize. Position/size are saved to localStorage so the
  // panel stays where you left it across page loads.
  // ---------------------------------------------------------------------
  let chatPanelDrag = null;   // { offsetX, offsetY } while dragging
  let chatPanelResize = null; // { startX, startY, startW, startH } while resizing
  let chatDragBound = false;

  function bindPanelDragAndResize() {
    const panel = document.querySelector("[data-chat-panel]");
    const dragHandle = document.querySelector("[data-chat-drag-handle]");
    const resizeHandle = document.querySelector("[data-chat-resize-handle]");
    if (!panel) return;

    if (dragHandle) dragHandle.addEventListener("mousedown", (e) => {
      if (!isPanelPoppedOut()) return;
      if (e.target.closest("[data-chat-close]")) return;
      const rect = panel.getBoundingClientRect();
      chatPanelDrag = { offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top };
      panel.classList.add("dragging");
      e.preventDefault();
    });

    if (resizeHandle) resizeHandle.addEventListener("mousedown", (e) => {
      if (!isPanelPoppedOut()) return;
      const rect = panel.getBoundingClientRect();
      chatPanelResize = { startX: e.clientX, startY: e.clientY, startW: rect.width, startH: rect.height };
      panel.classList.add("dragging");
      e.preventDefault();
      e.stopPropagation();
    });

    // Bound once ever — safe to call bindPanelDragAndResize() repeatedly (it runs on every
    // mount()) since this guard stops duplicate listeners from piling up.
    if (chatDragBound) return;
    chatDragBound = true;

    window.addEventListener("mousemove", (e) => {
      const livePanel = document.querySelector("[data-chat-panel]");
      if (!livePanel) return;

      if (chatPanelDrag) {
        const w = livePanel.offsetWidth, h = livePanel.offsetHeight;
        const left = Math.max(8, Math.min(e.clientX - chatPanelDrag.offsetX, window.innerWidth - w - 8));
        const top = Math.max(8, Math.min(e.clientY - chatPanelDrag.offsetY, window.innerHeight - h - 8));
        livePanel.style.left = left + "px";
        livePanel.style.top = top + "px";
        livePanel.style.right = "auto";
        setPanelPos({ left, top });
      }

      if (chatPanelResize) {
        const dx = e.clientX - chatPanelResize.startX;
        const dy = e.clientY - chatPanelResize.startY;
        const minW = 300, minH = 360;
        const maxW = window.innerWidth - 16, maxH = window.innerHeight - 16;
        const width = Math.max(minW, Math.min(maxW, chatPanelResize.startW + dx));
        const height = Math.max(minH, Math.min(maxH, chatPanelResize.startH + dy));
        livePanel.style.width = width + "px";
        livePanel.style.height = height + "px";
        setPanelSize({ width, height });
        const msgBox = livePanel.querySelector("[data-chat-messages]");
        if (msgBox) msgBox.scrollTop = msgBox.scrollHeight;
      }
    });

    window.addEventListener("mouseup", () => {
      if (!chatPanelDrag && !chatPanelResize) return;
      chatPanelDrag = null;
      chatPanelResize = null;
      document.querySelector("[data-chat-panel]")?.classList.remove("dragging");
    });
  }

  // ---------------------------------------------------------------------
  // VERSION LOCK — listens to latestVersion/{value,downloadUrl} in
  // Firebase. When the published value doesn't match CURRENT_VERSION, a
  // full-screen overlay covers the entire page — no dismiss button, no way
  // to interact with anything underneath — with a single link out to
  // wherever the new files are hosted. As soon as the player is running
  // the matching CURRENT_VERSION (i.e. they've downloaded + are now
  // opening the updated files), the overlay simply never appears.
  // ---------------------------------------------------------------------
  let unsubscribeVersion = null;
  let latestVersionCache = null;
  let latestDownloadUrlCache = "";

  function versionLockHTML(latest, downloadUrl) {
  const hasLink = !!(downloadUrl && downloadUrl.trim());
  const isDev = typeof window.Shell !== "undefined" && typeof Shell.isDeveloper === "function" && Shell.isDeveloper();
  return `<div class="chat-version-lock" data-version-lock>
    <div class="chat-version-lock-box">
      <div class="chat-version-lock-icon">${Shell.svg("bolt")}</div>
      <h2>Update Available</h2>
      <p>A newer version (v${escapeHTML(String(latest))}) is available. You need to download it before you can keep playing.</p>
      ${hasLink
        ? `<a class="chat-version-lock-btn" href="${downloadUrl}" target="_blank" rel="noopener noreferrer">${Shell.svg("bolt")} Download update</a>`
        : `<div class="chat-version-lock-btn disabled">Download link not set yet — check back soon</div>`}
      ${isDev ? `<button class="chat-version-lock-dev-bypass" data-version-bypass>${Shell.svg("wrench")} Developer bypass</button>` : ""}
    </div>
  </div>`;
}

  function showVersionLock(latest, downloadUrl) {
    if (document.querySelector("[data-version-lock]")) {
      const box = document.querySelector("[data-version-lock]");
      box.outerHTML = versionLockHTML(latest, downloadUrl);
    } else {
      document.body.insertAdjacentHTML("beforeend", versionLockHTML(latest, downloadUrl));
    }
    document.querySelector("[data-version-bypass]")?.addEventListener("click", hideVersionLock);
  }

  function hideVersionLock() {
    document.querySelector("[data-version-lock]")?.remove();
  }

  function startVersionCheck() {
    if (!ready || unsubscribeVersion) return;
    unsubscribeVersion = db.ref("latestVersion").on("value", (snap) => {
      const val = snap.val() || {};
      latestVersionCache = val.value != null ? String(val.value) : null;
      latestDownloadUrlCache = val.downloadUrl || "";
      if (!latestVersionCache || latestVersionCache === String(CURRENT_VERSION)) { hideVersionLock(); return; }
      showVersionLock(latestVersionCache, latestDownloadUrlCache);
    });
  }

  // Publishes a new required version to everyone. Called from the Developer Tools panel's Live
  // Update section (developer mode required), or directly from the console:
  // Chat.setLatestVersion("2"). Pass the SAME string you set as CURRENT_VERSION in the chat.js
  // you're about to hand out, so those updated files stop showing the lockout for themselves.
  function setLatestVersion(version) {
    if (!ready) { console.warn("Chat: Firebase isn't ready yet — wait a moment and try again."); return; }
    db.ref("latestVersion/value").set(String(version));
    console.log("Chat: latestVersion set to", version);
  }
  // Publishes/updates the download link shown on the lockout screen. Safe to call before or
  // after setLatestVersion — the overlay re-reads both fields live.
  function setDownloadUrl(url) {
    if (!ready) { console.warn("Chat: Firebase isn't ready yet — wait a moment and try again."); return; }
    db.ref("latestVersion/downloadUrl").set(String(url || ""));
    console.log("Chat: download URL set to", url);
  }
  // Convenience: publish both at once — used by the Developer Tools "Publish update" button.
  function publishUpdate(version, downloadUrl) {
    if (!ready) { console.warn("Chat: Firebase isn't ready yet — wait a moment and try again."); return; }
    db.ref("latestVersion").set({ value: String(version), downloadUrl: String(downloadUrl || "") });
    console.log("Chat: published update", version, downloadUrl);
  }
  // Read-only snapshot of what's currently published, for the dev panel to prefill its inputs.
  function getVersionInfo() {
    return { current: CURRENT_VERSION, latest: latestVersionCache, downloadUrl: latestDownloadUrlCache };
  }

  // ---------------------------------------------------------------------
  // DIRECT GIFTING — send balance straight to another online/known player
  // without a copy/paste code. Reuses gifts.js's threat model exactly:
  // there is still no trusted server, so this is a convenience relay, not
  // a new security boundary. Money moves like this:
  //   1) Sender clicks "Gift" on someone's profile card, enters an amount.
  //   2) Their OWN balance is deducted immediately (Shell.addCashBalance),
  //      then a record is pushed to directGifts/{recipientId}/{giftId}.
  //   3) The recipient's own browser (if it's open) is listening on
  //      directGifts/{myId} and, the moment it sees the new child, credits
  //      its OWN balance, shows a notification, and deletes the node.
  // If the recipient is offline when it's sent, the node just waits under
  // directGifts/{recipientId} until they next open the game and connect —
  // then their listener picks it up like any other pending child.
  // Needs one more Firebase rule added (see the notes at the bottom of
  // this file) — "directGifts" isn't covered by your current rules yet.
  // ---------------------------------------------------------------------
  function getProcessedGiftIds() {
    try {
      const raw = localStorage.getItem(DIRECT_GIFT_PROCESSED_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch {
      return new Set();
    }
  }
  function markGiftProcessed(giftId) {
    const ids = getProcessedGiftIds();
    ids.add(giftId);
    // Keep this list from growing forever — we only ever need "recent enough to catch a
    // duplicate event before Firebase confirms the delete", not a permanent record.
    const trimmed = Array.from(ids).slice(-300);
    localStorage.setItem(DIRECT_GIFT_PROCESSED_KEY, JSON.stringify(trimmed));
  }

  function startDirectGiftListener() {
    if (!ready || unsubscribeDirectGifts) return;
    const myId = Shell.getPlayerProfile().id;
    const giftsRef = db.ref("directGifts/" + myId);
    unsubscribeDirectGifts = giftsRef.on("child_added", (snap) => {
      const gift = snap.val();
      const giftId = snap.key;
      if (!gift) { giftsRef.child(giftId).remove(); return; }
      if (getProcessedGiftIds().has(giftId)) { giftsRef.child(giftId).remove(); return; } // already credited (e.g. other tab)
      const amount = Math.round(parseFloat(gift.amount) * 100) / 100;
      if (!(amount > 0)) { giftsRef.child(giftId).remove(); return; } // corrupt/garbage entry — never grant anything for it

      // Credit first, mark processed right after — then remove the node so it can't be
      // re-delivered on the next page load/reconnect.
      markGiftProcessed(giftId);
      Shell.addCashBalance(amount);
      Shell.addNotification({
        type: "gift",
        title: "You received a gift!",
        detail: `${gift.senderName || "A player"} gifted you ${Shell.fmtMoney(amount)}.`,
      });
      Shell.notify(`🎁 ${gift.senderName || "A player"} gifted you ${Shell.fmtMoney(amount)}!`);
      giftsRef.child(giftId).remove();
    }, (err) => {
      // Fires if reading directGifts/{myId} itself is rejected — almost always means the
      // "directGifts" rule isn't published yet (see firebase-rules.json).
      console.warn("Chat: couldn't listen for incoming gifts — check that your Firebase rules include a \"directGifts\" entry.", err);
    });
  }

  // Returns a Promise. Rejects with a plain Error (friendly .message) on any validation
  // failure OR if the Firebase write itself fails/is rejected by your database rules.
  //
  // IMPORTANT: unlike gifts.js's coded gifts (which deduct the instant the code is created,
  // because there's no live connection to fail), this only deducts your balance AFTER
  // Firebase confirms the write succeeded. That way a rules problem, a dropped connection,
  // etc. can never take your money without the recipient actually getting notified — it just
  // fails loudly instead, and your balance is untouched.
  function sendDirectGift(recipientId, recipientName, amountInput) {
    if (!ready) return Promise.reject(new Error("Chat isn't connected yet — try again in a moment."));
    const player = Shell.getPlayerProfile();
    if (!recipientId) return Promise.reject(new Error("Couldn't find that player."));
    if (recipientId === player.id) return Promise.reject(new Error("You can't gift yourself."));
    // Only ever send to a Player ID we can currently verify is online via live presence — never
    // to an ID pulled from an old chat message, which can go stale if that person switches
    // accounts, re-registers, etc. Sending to a stale ID would deduct your balance for nothing,
    // since nobody is listening on that ID anymore.
    const presenceEntry = presenceMap[recipientId];
    const recipientOnline = presenceEntry && presenceEntry.lastSeen && (Date.now() - presenceEntry.lastSeen) < PRESENCE_STALE_MS;
    if (!recipientOnline) return Promise.reject(new Error("That player isn't online anymore — refresh and try again."));

    const amount = Math.round(parseFloat(amountInput) * 100) / 100;
    if (!amount || isNaN(amount) || amount <= 0) return Promise.reject(new Error("Enter an amount greater than 0."));
    const balance = Shell.getCashBalance();
    if (amount > balance) return Promise.reject(new Error("You don't have enough balance to send that much."));

    return db.ref("directGifts/" + recipientId).push({
      senderId: player.id,
      senderName: player.name,
      amount,
      time: firebase.database.ServerValue.TIMESTAMP,
    }).then(() => {
      // Only now — write confirmed — do we take the money.
      Shell.addCashBalance(-amount);
      Shell.notify(`Gift sent to ${recipientName || "player"}!`);
      db.ref("chat").push({
        id: "", // system message, not clickable as a profile
        name: "",
        color: "",
        text: "",
        giftEvent: { senderName: player.name, recipientName: recipientName || "player", amount },
        time: firebase.database.ServerValue.TIMESTAMP,
      });
    }).catch((err) => {
      console.warn("Chat: direct gift failed to send.", err);
      // Surface a clearer message for the single most common cause (rules not published yet).
      if (err && /permission/i.test(err.message || "")) {
        throw new Error("Gift didn't send — your Firebase rules need a \"directGifts\" entry (see chat.js notes). Nothing was deducted.");
      }
      throw new Error("Gift didn't send — please check your connection and try again. Nothing was deducted.");
    });
  }

  // ---- profile card (center-screen, shows whoever you clicked) ----
  function getProfileInfo(id) {
    const p = presenceMap[id];
    if (p) {
      const online = p.lastSeen && (Date.now() - p.lastSeen) < PRESENCE_STALE_MS;
      return { name: p.name, color: p.color, rankLabel: p.rankLabel, rankTrack: p.rankTrack, wagered: p.wagered, online };
    }
    // Fallback for someone who chatted but has since gone offline — we only know what their
    // chat messages told us (name/color), so rank/wagered are shown as unknown.
    const fromMsg = [...messages].reverse().find((m) => m.id === id);
    if (fromMsg) return { name: fromMsg.name, color: fromMsg.color, rankLabel: null, wagered: null, online: false };
    return { name: "Player", color: "#5cffe7", rankLabel: null, wagered: null, online: false };
  }

  function profileCardHTML(id, info, isSelf) {
    const name = info.name || "Player";
    const initial = (name || "?").slice(0, 1).toUpperCase();
    return `<div class="shell-modal-overlay" data-chat-profile-overlay>
      <div class="shell-modal-box profile-modal-box">
        <div class="shell-modal-head">
          <h3>${Shell.svg("user")} Profile</h3>
          <button class="shell-modal-close" data-chat-profile-close aria-label="Close">${Shell.svg("x")}</button>
        </div>
        <div class="profile-name-row">
          <div class="profile-avatar-lg" style="background:${info.color || "#5cffe7"};">${escapeHTML(initial)}</div>
          <div>
            <div class="profile-name">${escapeHTML(name)}</div>
            <div class="profile-member">${info.online ? "Online now" : "Offline"}</div>
          </div>
        </div>
        <div class="profile-id-row"><span>ID:</span><strong>${escapeHTML(id)}</strong></div>
        <div class="profile-stat-grid">
          <div class="profile-stat-box"><div class="profile-stat-icon">${Shell.svg("trend")}</div><div><small>Rank</small><strong style="${info.rankTrack ? Shell.rankTextStyle(info.rankTrack) : ""}">${escapeHTML(info.rankLabel || "Unknown")}</strong></div></div>
          <div class="profile-stat-box"><div class="profile-stat-icon">${Shell.svg("coin")}</div><div><small>Lifetime Wagered</small><strong>${typeof info.wagered === "number" ? Shell.fmtMoney(info.wagered) : "Unknown"}</strong></div></div>
        </div>
        ${isSelf
          ? ""
          : info.online
            ? `<button class="chat-send-btn chat-gift-btn" data-chat-gift-open="${escapeHTML(id)}" data-chat-gift-name="${escapeHTML(name)}">${Shell.svg("gift")} Gift</button>`
            : `<div class="chat-gift-offline-note">${Shell.svg("bolt")} ${escapeHTML(name)} isn't online right now, so they can't be gifted this way. Wait until they're back online, or use a gift code from the Gifts page instead.</div>`}
      </div>
    </div>`;
  }

  function closeProfileCard() {
    document.querySelector("[data-chat-profile-overlay]")?.remove();
  }

  function openProfileCard(id) {
    if (!id) return;
    closeProfileCard();
    const myId = Shell.getPlayerProfile().id;
    const info = getProfileInfo(id);
    document.body.insertAdjacentHTML("beforeend", profileCardHTML(id, info, id === myId));
    const overlay = document.querySelector("[data-chat-profile-overlay]");
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeProfileCard(); });
    document.querySelector("[data-chat-profile-close]")?.addEventListener("click", closeProfileCard);
    document.querySelector("[data-chat-gift-open]")?.addEventListener("click", (e) => {
      openGiftModal(e.currentTarget.getAttribute("data-chat-gift-open"), e.currentTarget.getAttribute("data-chat-gift-name"));
    });
  }

  // ---- gift-amount modal (opens on top of the profile card) ----
  function giftModalHTML(name) {
    return `<div class="shell-modal-overlay top" data-chat-gift-overlay>
      <div class="shell-modal-box" style="max-width:340px;">
        <div class="shell-modal-head">
          <h3>${Shell.svg("gift")} Gift ${escapeHTML(name || "player")}</h3>
          <button class="shell-modal-close" data-chat-gift-close aria-label="Close">${Shell.svg("x")}</button>
        </div>
        <div class="dev-row">
          <div class="dev-row-label">Amount to gift</div>
          <div class="dev-row-controls">
            <input type="number" min="0" step="0.01" placeholder="0.00" data-chat-gift-amount>
            <button class="dev-btn" data-chat-gift-half type="button">½</button>
            <button class="dev-btn" data-chat-gift-double type="button">2×</button>
            <button class="dev-btn" data-chat-gift-max type="button">MAX</button>
          </div>
        </div>
        <div data-chat-gift-error style="display:none; margin:8px 0 0; color:var(--red); font-size:11px; font-weight:700;"></div>
        <button class="chat-send-btn chat-gift-btn" data-chat-gift-confirm style="width:100%; margin-top:14px; height:44px;">${Shell.svg("gift")} Confirm Gift</button>
      </div>
    </div>`;
  }

  function closeGiftModal() {
    document.querySelector("[data-chat-gift-overlay]")?.remove();
  }

  function openGiftModal(id, name) {
    closeGiftModal();
    document.body.insertAdjacentHTML("beforeend", giftModalHTML(name));
    const overlay = document.querySelector("[data-chat-gift-overlay]");
    const errBox = document.querySelector("[data-chat-gift-error]");
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeGiftModal(); });
    document.querySelector("[data-chat-gift-close]")?.addEventListener("click", closeGiftModal);
    document.querySelector("[data-chat-gift-amount]")?.focus();
    const amountInput = document.querySelector("[data-chat-gift-amount]");
    document.querySelector("[data-chat-gift-half]")?.addEventListener("click", () => {
      const v = parseFloat(amountInput.value) || 0;
      amountInput.value = (v / 2).toFixed(2);
    });
    document.querySelector("[data-chat-gift-double]")?.addEventListener("click", () => {
      const v = parseFloat(amountInput.value) || 0;
      const doubled = v * 2;
      const capped = Math.min(doubled, Shell.getCashBalance());
      amountInput.value = capped.toFixed(2);
    });
    document.querySelector("[data-chat-gift-max]")?.addEventListener("click", () => {
      amountInput.value = Shell.getCashBalance().toFixed(2);
    });
    const confirmBtn = document.querySelector("[data-chat-gift-confirm]");
    confirmBtn?.addEventListener("click", () => {
      const input = document.querySelector("[data-chat-gift-amount]");
      if (errBox) errBox.style.display = "none";
      confirmBtn.disabled = true;
      confirmBtn.textContent = "Sending…";
      sendDirectGift(id, name, input ? input.value : "")
        .then(() => {
          closeGiftModal();
          closeProfileCard();
        })
        .catch((err) => {
          confirmBtn.disabled = false;
          confirmBtn.innerHTML = `${Shell.svg("gift")} Confirm Gift`;
          if (errBox) { errBox.textContent = err.message || "Something went wrong."; errBox.style.display = "block"; }
        });
    });
  }

  // Bound once, ever — a single document-level delegated listener catches clicks on any
  // current OR future element carrying data-profile-id (chat names, online avatars, etc.),
  // so we don't need to re-bind it every time renderMessages()/renderPresenceList() re-draw.
  function bindProfileClicks() {
    if (profileClicksBound) return;
    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-profile-id]");
      if (el) openProfileCard(el.getAttribute("data-profile-id"));
    });
    profileClicksBound = true;
  }

  // ---------------------------------------------------------------------
  // MOUNT — inserts the toggle button into the topbar's action cluster
  // and the slide-out panel into the page, then wires everything up.
  // Safe to call on every page load, same pattern as Shell.mount().
  // ---------------------------------------------------------------------
  function mount() {
    // Insert the toggle button into the topbar's right-hand icon cluster,
    // right alongside the existing action-box icons (search/rewards/etc).
    const actionBox = document.querySelector(".top-actions .action-box:last-of-type") || document.querySelector(".top-actions");
    if (actionBox && !document.querySelector("[data-chat-toggle]")) {
      actionBox.insertAdjacentHTML("beforeend", toggleBtnHTML());
    }
    // Insert the slide-out panel once, appended to the body so it can be
    // fixed-position and slide in from the right regardless of page layout.
    if (!document.querySelector("[data-chat-panel]")) {
      document.body.insertAdjacentHTML("beforeend", panelHTML());
    }
    bindPanel();
    panelBound = true;
    bindProfileClicks();

    renderMessages();
    renderPresenceList();

    if (!initFirebase()) return; // config not filled in yet — panel still shows, just inert
    if (!unsubscribePresence) startPresence();
    if (!unsubscribeChat) startChatSync();
    startVersionCheck();
    startDirectGiftListener();

    window.addEventListener("beforeunload", () => {
      const player = Shell.getPlayerProfile();
      if (db) db.ref("presence/" + player.id).remove();
    });

    // Shell sometimes rebuilds the topbar asynchronously after mount() (e.g. pulling newer
    // account data from another device) which wipes out our injected chat button. Re-insert
    // it (and the panel, if somehow removed) whenever Shell tells us it repainted.
    document.addEventListener("nj:chrome-repainted", () => {
      const actionBox = document.querySelector(".top-actions .action-box:last-of-type") || document.querySelector(".top-actions");
      if (actionBox && !document.querySelector("[data-chat-toggle]")) {
        actionBox.insertAdjacentHTML("beforeend", toggleBtnHTML());
        bindPanel();
      }
    });
  }

  return { mount, isConfigured, setLatestVersion, setDownloadUrl, publishUpdate, getVersionInfo, CURRENT_VERSION, openProfileCard, sendDirectGift };
})();
