/* BaatRoom. No build step, trackers, third-party requests or HTML message rendering. */
"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const config = JSON.parse($("page-config").textContent);
  const themes = {ember: "Ember", aurora: "Aurora", ultraviolet: "Ultraviolet", arctic: "Arctic"};
  const memory = {
    get(key, persistent = false) { try { return (persistent ? localStorage : sessionStorage).getItem(key); } catch { return null; } },
    set(key, value, persistent = false) { try { (persistent ? localStorage : sessionStorage).setItem(key, value); } catch { /* Storage can be disabled in in-app browsers. */ } },
    remove(key) { try { sessionStorage.removeItem(key); } catch { /* Optional storage. */ } }
  };
  let csrf = "", self = null, socket = null, ready = false, leaving = false;
  let shareUrl = config.shareUrl, historyLimit = 100, messageTtl = 3600;
  let historyRevision = -1, presenceRevision = -1, serverInstance = null, clockOffset = 0;
  let selectedMessage = null, mutedUntil = 0, unread = 0, typingGuests = [], participants = [];
  let initialSnapshot = true, lastTyping = 0, typingTimer, retryTimer, toastTimer;
  const messages = new Map(), pending = new Map(), notices = new Map();
  let blocked;
  try { const value = JSON.parse(memory.get("baatroom.blocks") || "[]"); blocked = new Set(Array.isArray(value) ? value.slice(0, 500) : []); }
  catch { blocked = new Set(); }
  const serverNow = () => Date.now() / 1000 + clockOffset;
  const codepoints = (text) => Array.from(text).length;
  const displayName = (guest) => `${guest.nickname} #${guest.suffix}`;
  const initials = (name) => Array.from(name.trim())[0]?.toLocaleUpperCase() || "?";
  const nearBottom = () => $("messages").scrollHeight - $("messages").scrollTop - $("messages").clientHeight < 110;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#i-${name}`); svg.append(use); return svg;
  }
  function toast(text) {
    clearTimeout(toastTimer); $("toast").textContent = text; $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 4500);
  }
  function openDialog(id) { const dialog = $(id); if (!dialog.open) dialog.showModal(); }
  document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => {
    updateBlocked(); openDialog(button.dataset.open);
  }));
  document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  $("join-dialog").addEventListener("cancel", (event) => event.preventDefault());

  // Appearance is local; theme choices are never sent to the server.
  function setTheme(theme) {
    if (!themes[theme]) theme = "ember";
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll("[data-set-theme]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.setTheme === theme)));
    document.querySelectorAll(".appearance-link").forEach((b) => b.replaceChildren(document.createTextNode(themes[theme]), el("span", "", "↗")));
    memory.set("baatroom.theme", theme, true);
  }
  document.querySelectorAll("[data-set-theme]").forEach((b) => b.addEventListener("click", () => setTheme(b.dataset.setTheme)));
  setTheme(memory.get("baatroom.theme", true) || "ember");
  $("glow-toggle").checked = memory.get("baatroom.glow", true) !== "off";
  function setGlow() {
    const value = $("glow-toggle").checked ? "on" : "off";
    document.documentElement.dataset.glow = value; memory.set("baatroom.glow", value, true);
  }
  setGlow(); $("glow-toggle").addEventListener("change", setGlow);

  // visualViewport keeps the composer above mobile software keyboards.
  function resizeViewport() {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty("--app-height", `${viewport ? viewport.height : window.innerHeight}px`);
    document.documentElement.style.setProperty("--app-top", `${viewport ? viewport.offsetTop : 0}px`);
    if (ready && nearBottom()) scrollBottom();
  }
  window.visualViewport?.addEventListener("resize", resizeViewport);
  window.visualViewport?.addEventListener("scroll", resizeViewport);
  window.addEventListener("resize", resizeViewport); resizeViewport();

  async function api(path, data) {
    const options = {credentials: "same-origin", cache: "no-store"};
    if (data !== undefined) Object.assign(options, {method: "POST", headers: {"Content-Type": "application/json", "X-CSRF-Token": csrf}, body: JSON.stringify(data)});
    const response = await fetch(path, options);
    let result;
    try { result = await response.json(); } catch { throw new Error("The server is unavailable. Please try again shortly."); }
    if (!response.ok || !result.ok) throw new Error(result.error || "The request could not be completed.");
    return result;
  }
  function connectionState(kind, detail = "") {
    const online = kind === "online";
    document.body.classList.toggle("is-connected", online);
    const labels = {online: "You’re in. Make yourself at home.", connecting: "Connecting to Everyone…", reconnecting: "Reconnecting to Everyone…", offline: "You’re disconnected", waiting: "Pick a nickname to join Everyone"};
    $("connection-state").textContent = labels[kind] || kind;
    $("connection-banner").hidden = online || kind === "waiting" || kind === "connecting";
    $("connection-detail").textContent = detail || "Connection interrupted. We’ll reconnect when the network returns.";
    if (!online) {
      $("online-count").textContent = "— online";
      $("participant-list").replaceChildren(el("li", "participant-empty", "Reconnect to see who is here."));
    }
    updateComposer();
  }
  function setSelf(guest) {
    self = guest;
    $("self-name").textContent = guest ? guest.nickname : "Your seat is waiting";
    $("self-suffix").textContent = guest ? `Guest #${guest.suffix}` : "No account needed";
    $("self-avatar").textContent = guest ? initials(guest.nickname) : "?";
    document.querySelectorAll(".leave-button").forEach((b) => { b.disabled = !guest; });
    if (guest) memory.set("baatroom.nickname", guest.nickname);
  }
  function showJoin(error = "") {
    ready = false; setSelf(null); connectionState("waiting");
    $("join-submit").disabled = !csrf;
    $("join-error").hidden = !error; $("join-error").textContent = error;
    $("nickname").value = memory.get("baatroom.nickname") || "";
    openDialog("join-dialog");
    // Do not pop the keyboard automatically in a mobile in-app browser.
    if (matchMedia("(min-width: 901px)").matches) $("nickname").focus();
  }
  async function bootstrap(autoResume = true) {
    const data = await api("/api/bootstrap");
    csrf = data.csrf; shareUrl = data.share_url; messageTtl = data.message_ttl; historyLimit = data.history_limit;
    $("share-url").value = shareUrl;
    $("privacy-limit").textContent = historyLimit;
    $("privacy-ttl").textContent = messageTtl === 3600 ? "one hour" : `${messageTtl} seconds`;
    if (data.guest && autoResume) { setSelf(data.guest); $("join-dialog").close(); connectSocket(); }
    else if (!data.guest) showJoin(data.restriction_until > serverNow() ? "The owner temporarily disconnected this guest session. Try again after the restriction expires." : "");
    return data;
  }
  $("join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const nickname = $("nickname").value.normalize("NFC").trim();
    if (codepoints(nickname) < 2 || codepoints(nickname) > 24) {
      $("join-error").textContent = "Choose a nickname with 2–24 characters."; $("join-error").hidden = false; return;
    }
    $("join-submit").disabled = true; $("join-error").hidden = true;
    try {
      if (!csrf) await bootstrap(false);
      const data = await api("/api/join", {nickname});
      setSelf(data.guest); $("join-dialog").close(); connectSocket();
    } catch (error) { $("join-error").textContent = error.message; $("join-error").hidden = false; }
    finally { $("join-submit").disabled = false; }
  });

  function connectSocket() {
    clearTimeout(retryTimer); initialSnapshot = true; ready = false; presenceRevision = -1;
    if (socket) { socket.removeAllListeners(); socket.disconnect(); }
    connectionState("connecting");
    if (typeof io !== "function") { connectionState("offline", "The local chat client could not load. Reload the page."); return; }
    socket = io({autoConnect: false, auth: {csrf}, transports: ["polling", "websocket"],
      reconnection: true, reconnectionDelay: 1000, reconnectionDelayMax: 10000,
      randomizationFactor: 0.5, timeout: 12000});
    socket.on("snapshot", applySnapshot);
    socket.on("presence", applyPresence);
    socket.on("connect", () => { if (ready) connectionState("online"); });
    socket.on("disconnect", () => {
      ready = false; typingGuests = []; renderTyping();
      pending.forEach((p) => { if (p.status === "sending") { p.status = "failed"; p.error = "Delivery unconfirmed. Retry after reconnecting."; } });
      renderTimeline();
      if (!leaving && self) connectionState("reconnecting");
    });
    socket.io.on("reconnect_attempt", () => { if (self) connectionState("reconnecting"); });
    socket.on("connect_error", () => {
      ready = false;
      connectionState(navigator.onLine ? "reconnecting" : "offline", "Can’t reach the room. Check your connection, or the room may be full.");
      if (!socket.active && !leaving) {
        clearTimeout(retryTimer);
        retryTimer = setTimeout(async () => { try { await bootstrap(); } catch { connectionState("offline"); } }, 6000);
      }
    });
    socket.on("message", (data) => {
      if (data.revision <= historyRevision) return;
      historyRevision = data.revision;
      const message = data.message, following = nearBottom();
      if (message.guest_id === self?.id) pending.delete(message.client_id);
      if (message.expires_at > serverNow()) messages.set(message.id, message);
      trimHistory(); renderTimeline();
      if (following || message.guest_id === self?.id) scrollBottom();
      else if (!blocked.has(message.guest_id)) { unread++; updateUnread(); }
      if (message.guest_id !== self?.id && !blocked.has(message.guest_id)) {
        $("message-announcer").textContent = `${displayName(message)}: ${message.text}`;
      }
    });
    socket.on("messages_removed", (data) => {
      if (data.revision <= historyRevision) return;
      historyRevision = data.revision;
      data.ids.forEach((id) => messages.delete(id));
      if (selectedMessage && data.ids.includes(selectedMessage.id)) selectedMessage = null;
      renderTimeline();
    });
    socket.on("notice", (data) => {
      notices.set(data.id, data);
      while (notices.size > 30) notices.delete(notices.keys().next().value);
      renderTimeline();
    });
    socket.on("typing", (data) => { typingGuests = data.guests; renderTyping(); });
    socket.on("muted", (data) => { mutedUntil = data.until; updateComposer(); toast("The room owner temporarily muted this guest session."); });
    socket.on("session_ended", (data) => {
      leaving = true; clearTimeout(retryTimer); socket.disconnect();
      ready = false; setSelf(null); messages.clear(); pending.clear(); notices.clear(); renderTimeline();
      showJoin(data.until > serverNow() ? data.reason : "");
      toast(data.reason); leaving = false;
    });
    socket.connect();
  }
  function applySnapshot(data) {
    if (!data?.ok) return;
    clockOffset = data.server_time - Date.now() / 1000;
    if (serverInstance !== data.server_instance) {
      messages.clear(); notices.clear(); historyRevision = -1; serverInstance = data.server_instance;
    }
    setSelf(data.self); mutedUntil = data.muted_until;
    if (data.revision >= historyRevision) {
      historyRevision = data.revision; messages.clear();
      data.messages.forEach((message) => {
        if (message.expires_at > serverNow()) messages.set(message.id, message);
        if (message.guest_id === self.id) pending.delete(message.client_id);
      });
    }
    ready = true; connectionState("online"); applyPresence(data.presence);
    typingGuests = data.typing; renderTyping(); renderTimeline();
    if (initialSnapshot) { scrollBottom(); initialSnapshot = false; }
    $("join-dialog").close(); updateComposer();
  }
  function applyPresence(data) {
    if (data.revision < presenceRevision) return;
    presenceRevision = data.revision; participants = data.participants;
    $("online-count").textContent = `${data.count} online`;
    renderParticipants();
  }
  function renderParticipants() {
    const fragment = document.createDocumentFragment();
    participants.forEach((guest) => {
      const row = el("li"), copy = el("div", "participant-copy");
      copy.append(el("strong", "", guest.nickname + (guest.id === self?.id ? " (you)" : "")),
        el("small", "", `Guest #${guest.suffix}${blocked.has(guest.id) ? " · blocked for you" : ""}`));
      row.append(el("span", "avatar", initials(guest.nickname)), copy, el("span", "small-led")); fragment.append(row);
    });
    if (!participants.length) fragment.append(el("li", "participant-empty", "Nobody is connected yet."));
    $("participant-list").replaceChildren(fragment);
  }
  function toggleParticipants(open) {
    $("participants").hidden = !open; $("online-button").setAttribute("aria-expanded", String(open));
  }
  $("online-button").addEventListener("click", () => toggleParticipants($("participants").hidden));
  $("close-participants").addEventListener("click", () => { toggleParticipants(false); $("online-button").focus(); });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && !$("participants").hidden) toggleParticipants(false); });

  function messageNode(message, optimistic = false) {
    const own = optimistic || message.guest_id === self?.id;
    const article = el("article", `message-row${own ? " own" : ""}${optimistic ? " pending" : ""}`);
    article.dataset.messageId = optimistic ? message.client_id : message.id;
    article.dataset.guestId = own ? self?.id || "" : message.guest_id;
    const content = el("div", "message-content"), meta = el("div", "message-meta");
    const sender = own ? self : message;
    meta.append(el("span", "sender", own ? "You" : sender.nickname), el("span", "guest-suffix", `#${sender.suffix}`));
    const time = el("time", "", new Intl.DateTimeFormat(undefined, {hour: "numeric", minute: "2-digit"}).format(new Date(optimistic ? message.created * 1000 : message.timestamp)));
    time.dateTime = optimistic ? new Date(message.created * 1000).toISOString() : message.timestamp;
    time.title = new Date(time.dateTime).toLocaleString(); meta.append(time);
    content.append(meta, el("div", "bubble", message.text));
    if (own) {
      const delivery = el("div", "delivery" + (message.status === "failed" ? " failed" : ""));
      if (!optimistic) delivery.append(el("span", "", "Sent ✓"));
      else if (message.status === "sending") delivery.append(el("span", "", "Sending…"));
      else {
        delivery.append(el("span", "", message.error || "Delivery unconfirmed"));
        const retry = el("button", "retry-button", "Retry"); retry.type = "button"; retry.disabled = !ready;
        retry.addEventListener("click", () => transmit(message)); delivery.append(retry);
      }
      content.append(delivery);
    }
    article.append(el("span", "avatar", initials(sender.nickname)), content);
    if (!own) {
      const actions = el("button", "message-actions", "···"); actions.type = "button";
      actions.setAttribute("aria-label", `Message options for ${displayName(sender)}`);
      actions.addEventListener("click", () => {
        selectedMessage = message; $("actions-guest").textContent = displayName(message); openDialog("actions-dialog");
      }); article.append(actions);
    }
    return article;
  }
  function renderTimeline() {
    const scroller = $("messages"), following = nearBottom(), oldTop = scroller.scrollTop;
    const anchor = [...$("timeline").children].find((n) => n.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top);
    const anchorId = anchor?.dataset.messageId, anchorY = anchor?.getBoundingClientRect().top;
    const entries = [];
    messages.forEach((message) => { if (!blocked.has(message.guest_id) && message.expires_at > serverNow()) entries.push({t: message.created_at, message}); });
    pending.forEach((message) => { if (self) entries.push({t: message.created, message, pending: true}); });
    notices.forEach((entry) => { if (entry.expires_at > serverNow() && !blocked.has(entry.guest.id)) entries.push({t: Date.parse(entry.timestamp) / 1000, notice: entry}); });
    entries.sort((a, b) => a.t - b.t);
    const fragment = document.createDocumentFragment();
    entries.forEach((entry) => {
      if (entry.notice) fragment.append(el("div", "system-notice", `${displayName(entry.notice.guest)} ${entry.notice.action === "joined" ? "joined the room" : "left the room"}`));
      else fragment.append(messageNode(entry.message, entry.pending));
    });
    $("timeline").replaceChildren(fragment);
    const visibleCount = entries.filter((entry) => !entry.notice).length;
    $("empty-state").hidden = visibleCount > 0;
    $("room-welcome").hidden = visibleCount > 0;
    document.querySelector(".history-divider").hidden = visibleCount === 0;
    if (following) scrollBottom();
    else if (anchorId) {
      const replacement = [...$("timeline").children].find((n) => n.dataset.messageId === anchorId);
      scroller.scrollTop = replacement ? oldTop + replacement.getBoundingClientRect().top - anchorY : oldTop;
    } else scroller.scrollTop = oldTop;
  }
  function scrollBottom() {
    $("messages").scrollTop = $("messages").scrollHeight; unread = 0; updateUnread();
  }
  function updateUnread() {
    $("new-messages").hidden = unread === 0;
    $("new-messages").querySelector("span").textContent = unread === 1 ? "1 new message" : `${unread} new messages`;
  }
  $("new-messages").addEventListener("click", scrollBottom);
  $("messages").addEventListener("scroll", () => { if (nearBottom()) { unread = 0; updateUnread(); } }, {passive: true});
  function trimHistory() {
    [...messages.values()].sort((a, b) => a.created_at - b.created_at).slice(0, Math.max(0, messages.size - historyLimit)).forEach((m) => messages.delete(m.id));
  }
  function renderTyping() {
    const names = typingGuests.filter((g) => g.id !== self?.id && !blocked.has(g.id) && g.expires_at > serverNow()).map(displayName);
    if (!names.length || !ready) { $("typing-line").replaceChildren(); return; }
    const text = names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : `${names[0]} and ${names.length - 1} others are typing`;
    $("typing-line").replaceChildren(el("span", "typing-dots", "···"), el("span", "", text));
  }
  function updateComposer() {
    const muted = mutedUntil > serverNow(), active = ready && socket?.connected && self;
    $("message-input").disabled = !active || muted;
    const length = codepoints($("message-input").value.normalize("NFC").trim());
    $("send-button").disabled = !active || muted || length === 0 || length > 1000;
    $("char-count").textContent = `${length.toLocaleString()} / 1,000`;
    $("char-count").classList.toggle("over-limit", length > 1000);
    $("mute-state").hidden = !muted;
    if (muted) $("mute-state").textContent = `This guest session is muted for ${Math.ceil((mutedUntil - serverNow()) / 60)} more minute(s).`;
    document.querySelectorAll(".retry-button").forEach((b) => { b.disabled = !active || muted; });
  }
  function sendTyping(active) {
    if (!ready || !socket?.connected || mutedUntil > serverNow()) return;
    if (active && Date.now() - lastTyping < 1700) return;
    lastTyping = Date.now(); socket.volatile.emit("typing", {active});
  }
  $("message-input").addEventListener("input", () => {
    const input = $("message-input"); input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 132)}px`;
    updateComposer(); clearTimeout(typingTimer);
    sendTyping(Boolean(input.value.trim())); typingTimer = setTimeout(() => sendTyping(false), 2200);
  });
  $("message-input").addEventListener("blur", () => sendTyping(false));
  $("message-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !matchMedia("(pointer: coarse)").matches) {
      event.preventDefault(); $("composer").requestSubmit();
    }
  });
  function clientId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes); return [...bytes].map((n) => n.toString(16).padStart(2, "0")).join("");
  }
  $("composer").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("message-input"), text = input.value.normalize("NFC").trim();
    if (!ready || !socket?.connected || mutedUntil > serverNow() || !text || codepoints(text) > 1000) return;
    if (pending.size >= 20) { toast("Resolve the pending messages before sending more."); return; }
    const message = {text, client_id: clientId(), created: serverNow(), status: "sending"};
    pending.set(message.client_id, message); input.value = ""; input.style.height = "auto";
    sendTyping(false); updateComposer(); renderTimeline(); scrollBottom(); transmit(message); input.focus();
  });
  function transmit(message) {
    if (!ready || !socket?.connected) { toast("Reconnect before retrying."); return; }
    if (message.created + messageTtl <= serverNow()) { pending.delete(message.client_id); renderTimeline(); toast("This pending message expired."); return; }
    message.status = "sending"; message.error = ""; renderTimeline();
    const currentSocket = socket;
    currentSocket.timeout(7000).emit("send_message", {text: message.text, client_id: message.client_id}, (error, result) => {
      if (!pending.has(message.client_id)) return; // An authoritative server echo already confirmed it.
      if (error || !result?.ok) {
        message.status = "failed"; message.error = error ? "Delivery unconfirmed" : result?.error || "Message not accepted";
        if (result?.muted_until) mutedUntil = result.muted_until;
      } else {
        pending.delete(message.client_id);
        if (result.message && result.message.expires_at > serverNow()) messages.set(result.message.id, result.message);
        else toast("Previously delivered. That message is no longer in recent history.");
      }
      trimHistory(); renderTimeline(); updateComposer();
    });
  }

  function updateBlocked() {
    $("blocked-count").textContent = `${blocked.size} locally blocked guest${blocked.size === 1 ? "" : "s"}`;
    $("unblock-button").disabled = blocked.size === 0;
  }
  $("block-button").addEventListener("click", () => {
    if (!selectedMessage) { $("actions-dialog").close(); toast("This message has expired or been removed."); return; }
    if (blocked.size >= 500) { toast("Your local block list is full. Unblock guests in Privacy first."); return; }
    blocked.add(selectedMessage.guest_id); memory.set("baatroom.blocks", JSON.stringify([...blocked]));
    $("actions-dialog").close(); renderTimeline(); renderParticipants(); renderTyping(); updateBlocked(); toast("Guest blocked. Their messages are hidden for you in this tab.");
  });
  $("unblock-button").addEventListener("click", () => {
    blocked.clear(); memory.remove("baatroom.blocks"); renderTimeline(); renderParticipants(); renderTyping(); updateBlocked();
  });
  $("report-button").addEventListener("click", () => {
    $("actions-dialog").close();
    if (!selectedMessage) { toast("This message has expired or been removed."); return; }
    $("report-error").hidden = true; openDialog("report-dialog");
  });
  $("report-form").addEventListener("submit", (event) => {
    event.preventDefault(); $("report-error").hidden = true;
    if (!selectedMessage || !ready || !socket?.connected) {
      $("report-error").textContent = "Reconnect and choose a recent message to report."; $("report-error").hidden = false; return;
    }
    $("report-submit").disabled = true;
    socket.timeout(7000).emit("report_message", {message_id: selectedMessage.id, reason: $("report-reason").value}, (error, result) => {
      $("report-submit").disabled = false;
      if (error || !result?.ok || !result.received) {
        $("report-error").textContent = error ? "Report receipt could not be confirmed. Please try again." : result?.error || "The report was not received.";
        $("report-error").hidden = false;
      } else { $("report-dialog").close(); toast("Report received. The room owner can review it."); }
    });
  });

  // Native share first; clipboard second; selectable URL always available.
  async function copyLink(manual = false) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(shareUrl);
      if ($("share-dialog").open) $("share-dialog").close(); toast("Invite link copied. Bring your people.");
    } catch {
      $("share-url").value = shareUrl; openDialog("share-dialog"); $("share-url").focus(); $("share-url").select();
      if (manual) $("share-help").textContent = "Automatic copy is unavailable. Press and hold the link, or press Ctrl+C / ⌘C, to copy it.";
    }
  }
  $("invite-button").addEventListener("click", async () => {
    if (navigator.share) {
      try { await navigator.share({title: config.name, text: "Come hang out in Everyone. Pick a nickname and say hello.", url: shareUrl}); return; }
      catch (error) { if (error.name === "AbortError") return; }
    }
    await copyLink();
  });
  $("copy-link").addEventListener("click", () => copyLink(true));
  $("share-url").addEventListener("click", () => $("share-url").select());

  async function reconnect() {
    if (leaving) return;
    $("reconnect-button").disabled = true;
    try { await bootstrap(); } catch { connectionState("offline", "The server is unavailable. Please try again shortly."); }
    finally { $("reconnect-button").disabled = false; }
  }
  $("reconnect-button").addEventListener("click", reconnect);
  window.addEventListener("online", () => { if (!ready && self) reconnect(); });
  window.addEventListener("offline", () => { ready = false; connectionState("offline", "You’re offline. Your draft stays here while we wait for the network."); });
  document.querySelectorAll(".leave-button").forEach((button) => button.addEventListener("click", async () => {
    if (leaving || !self) return; leaving = true; button.disabled = true;
    try {
      await api("/api/leave", {}); clearTimeout(retryTimer); socket?.disconnect();
      ready = false; messages.clear(); pending.clear(); notices.clear(); blocked.clear();
      memory.remove("baatroom.nickname"); memory.remove("baatroom.blocks");
      $("message-input").value = ""; setSelf(null); renderTimeline(); showJoin(); toast("You left the room.");
    } catch (error) { toast(error.message); button.disabled = false; }
    finally { leaving = false; }
  }));

  // Expiry is local as well as server-driven, including while disconnected.
  setInterval(() => {
    let changed = false;
    messages.forEach((m, id) => { if (m.expires_at <= serverNow()) { messages.delete(id); changed = true; if (selectedMessage?.id === id) selectedMessage = null; } });
    pending.forEach((m, id) => { if (m.created + messageTtl <= serverNow()) { pending.delete(id); changed = true; } });
    notices.forEach((n, id) => { if (n.expires_at <= serverNow()) { notices.delete(id); changed = true; } });
    if (changed) renderTimeline(); renderTyping(); updateComposer();
  }, 1000);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && socket?.connected && ready) socket.timeout(7000).emit("sync", {}, (error, data) => { if (!error && data?.ok) applySnapshot(data); });
  });
  updateBlocked();
  bootstrap().catch(() => {
    showJoin("The server is unavailable. Reload this page in a moment to try again.");
    $("join-submit").disabled = false;
  });
})();
