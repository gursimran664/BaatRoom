/* Browser-only audio calls. No phone numbers, recording, or microphone on join. */
"use strict";
window.createCallControls = ({request, notify, openPrivate, getSelf}) => {
  const $ = (id) => document.getElementById(id);
  let socket = null, call = null, incoming = null;
  const supported = () => window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.RTCPeerConnection;
  const name = (g) => `${g.nickname} #${g.suffix}`;

  function cleanup(message = "") {
    const old = call; call = null; incoming = null;
    if (old) {
      clearInterval(old.ping); clearInterval(old.clock); clearTimeout(old.timeout); clearTimeout(old.lost);
      old.stream?.getTracks().forEach((track) => track.stop());
      if (old.pc) { old.pc.onconnectionstatechange = null; old.pc.close(); }
    }
    $("remote-audio").pause(); $("remote-audio").srcObject = null;
    $("call-panel").hidden = true; $("incoming-call-dialog").close();
    $("call-mute").hidden = true; $("call-mute").setAttribute("aria-pressed", "false");
    $("call-mute").textContent = "Mute microphone"; $("resume-audio").hidden = true;
    $("accept-call").disabled = false;
    if (message) notify(message);
  }
  function hangup(message = "Call ended.") {
    const id = call?.id;
    if (id && socket?.connected) request("call_end", {id}).catch(() => {});
    cleanup(message);
  }
  function status(text) { $("call-status").textContent = text; }
  function panel(peer) {
    $("call-peer").textContent = `Audio call · ${name(peer)}`; $("call-panel").hidden = false;
  }
  async function microphone(active) {
    if (!supported()) throw new Error("Audio calls need HTTPS (or localhost) and a browser with microphone support. Try opening the link in Chrome or Safari.");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      if (call !== active) { stream.getTracks().forEach((t) => t.stop()); return false; }
      active.stream = stream; $("call-mute").hidden = false; return true;
    } catch (error) {
      if (error.name === "NotAllowedError") throw new Error("Microphone permission was denied. Allow it in your browser settings to make a call.");
      throw new Error("The microphone is unavailable. Check your device and browser permission.");
    }
  }
  function newCall(peer, role, id = null) {
    const active = {peer, role, id, pc: null, stream: null, connected: false, queue: [], ice: [], flushing: false};
    call = active; panel(peer); status("Waiting for microphone permission…");
    active.timeout = setTimeout(() => { if (call === active && !active.connected) hangup("The call could not connect. Public internet calls may need the owner's TURN relay."); }, 60000);
    active.ping = setInterval(() => {
      if (call === active && active.id && socket?.connected) request("call_ping", {id: active.id, connected: active.connected}).catch(() => {
        if (call === active) cleanup("The call connection was lost.");
      });
    }, 15000);
    return active;
  }
  async function signal(active, kind, value) {
    if (call !== active || !active.id) return;
    await request("call_signal", {id: active.id, kind, value});
  }
  async function playRemote() {
    try { await $("remote-audio").play(); $("resume-audio").hidden = true; }
    catch { if (call) $("resume-audio").hidden = false; }
  }
  function peerConnection(active, rtc) {
    if (call !== active) return;
    active.pc = new RTCPeerConnection(rtc);
    active.stream.getTracks().forEach((track) => active.pc.addTrack(track, active.stream));
    active.pc.onicecandidate = (event) => {
      if (event.candidate && call === active) signal(active, "candidate", event.candidate.toJSON()).catch(() => {
        if (call === active) hangup("The call setup was interrupted. Please try again.");
      });
    };
    active.pc.ontrack = (event) => {
      if (call !== active) return;
      $("remote-audio").srcObject = event.streams[0] || new MediaStream([event.track]);
      playRemote();
    };
    active.pc.onconnectionstatechange = () => {
      if (call !== active) return;
      const state = active.pc.connectionState;
      if (state === "connected") {
        clearTimeout(active.lost); clearTimeout(active.timeout); active.connected = true;
        active.started ||= Date.now();
        const clock = () => {
          const seconds = Math.floor((Date.now() - active.started) / 1000);
          status(`Connected · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`);
        };
        clock(); if (!active.clock) active.clock = setInterval(clock, 1000);
        request("call_ping", {id: active.id, connected: true}).catch(() => { if (call === active) hangup("The call ended."); });
      } else if (state === "failed") {
        hangup("Audio could not connect. A TURN relay may be needed for these networks.");
      } else if (state === "disconnected") {
        active.connected = false; clearInterval(active.clock); active.clock = null;
        status("Audio connection interrupted…");
        clearTimeout(active.lost); active.lost = setTimeout(() => { if (call === active && !active.connected) hangup("Audio connection lost. Try calling again."); }, 12000);
      }
    };
    flush(active);
  }
  async function flush(active) {
    if (call !== active || !active.pc || active.flushing) return;
    active.flushing = true;
    try {
      while (call === active && active.queue.length) {
        const data = active.queue.shift();
        if (data.kind === "candidate") {
          if (active.pc.remoteDescription) await active.pc.addIceCandidate(data.value);
          else active.ice.push(data.value);
        } else {
          await active.pc.setRemoteDescription(data.value);
          while (active.ice.length) await active.pc.addIceCandidate(active.ice.shift());
          if (data.kind === "offer") {
            const answer = await active.pc.createAnswer(); await active.pc.setLocalDescription(answer);
            await signal(active, "answer", {type: "answer", sdp: active.pc.localDescription.sdp});
          }
        }
      }
    } catch { if (call === active) hangup("The call setup failed. Please try again."); }
    finally { active.flushing = false; }
  }
  async function offer(active) {
    if (call !== active || active.pc) return;
    try {
      peerConnection(active, active.rtc); status("Connecting audio…");
      const description = await active.pc.createOffer(); await active.pc.setLocalDescription(description);
      await signal(active, "offer", {type: "offer", sdp: active.pc.localDescription.sdp});
    } catch { if (call === active) hangup("The call setup failed. Please try again."); }
  }
  async function start(peer) {
    if (call || incoming) { notify("Finish the current call first."); return; }
    if (!getSelf()?.calls_enabled) { notify("Turn on Allow audio calls in Guest settings first."); $("preferences-dialog").showModal(); return; }
    const active = newCall(peer, "caller");
    try {
      if (!await microphone(active)) return;
      const result = await request("call_start", {recipient_id: peer.id, client_id: crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join("")});
      if (call !== active) { request("call_end", {id: result.id}).catch(() => {}); return; }
      active.id = result.id; active.rtc = result.rtc;
      if (active.earlyEnd === result.id) { cleanup("The call ended."); return; }
      status("Calling… Waiting for an answer.");
      if (active.earlyAccept === result.id) offer(active);
    } catch (error) { if (call === active) hangup(error.message); }
  }
  function incomingCall(data) {
    if (!data || incoming?.id === data.id || call?.id === data.id) return;
    if (call || incoming) return;
    incoming = data; $("incoming-call-peer").textContent = name(data.peer);
    $("accept-call").disabled = false; $("incoming-call-dialog").showModal();
  }
  async function accept() {
    if (!incoming || call) return;
    const item = incoming, active = newCall(item.peer, "callee", item.id);
    $("accept-call").disabled = true;
    try {
      if (!await microphone(active)) return;
      const result = await request("call_respond", {id: item.id, accept: true});
      if (call !== active) return;
      incoming = null; $("incoming-call-dialog").close();
      active.rtc = result.rtc; status("Connecting audio…");
      openPrivate(item.peer); peerConnection(active, result.rtc);
    } catch (error) {
      if (call === active) {
        request("call_respond", {id: item.id, accept: false}).catch(() => {});
        hangup(error.message);
      }
    }
  }
  function decline() {
    if (!incoming) return;
    const id = incoming.id;
    request("call_respond", {id, accept: false}).catch((error) => notify(error.message));
    if (call?.id === id) request("call_end", {id}).catch(() => {});
    cleanup("Call declined.");
  }
  function attach(current) {
    socket = current;
    socket.on("call_incoming", incomingCall);
    socket.on("call_accepted", (data) => {
      if (!call || call.role !== "caller") return;
      if (!call.id) call.earlyAccept = data.id;
      else if (call.id === data.id) offer(call);
    });
    socket.on("call_answered", (data) => {
      if (data.accepted_sid !== socket.id && (incoming?.id === data.id || call?.id === data.id)) cleanup("This call was answered in another tab.");
    });
    socket.on("call_signal", (data) => {
      if (call?.id !== data.id) return;
      if (call.queue.length >= 100) { hangup("Too many call updates."); return; }
      call.queue.push(data); flush(call);
    });
    socket.on("call_ended", (data) => {
      if (call?.id === data.id || incoming?.id === data.id) cleanup(data.reason);
      else if (call && !call.id && call.role === "caller") call.earlyEnd = data.id;
    });
  }
  $("accept-call").addEventListener("click", accept);
  $("decline-call").addEventListener("click", decline);
  $("incoming-call-dialog").addEventListener("cancel", (event) => { event.preventDefault(); decline(); });
  $("call-hangup").addEventListener("click", () => {
    if (incoming && call?.role === "callee") decline(); else hangup();
  });
  $("call-mute").addEventListener("click", () => {
    if (!call?.stream) return;
    const muted = $("call-mute").getAttribute("aria-pressed") !== "true";
    call.stream.getAudioTracks().forEach((track) => { track.enabled = !muted; });
    $("call-mute").setAttribute("aria-pressed", String(muted));
    $("call-mute").textContent = muted ? "Unmute microphone" : "Mute microphone";
  });
  $("resume-audio").addEventListener("click", playRemote);
  window.addEventListener("pagehide", () => { if (call || incoming) hangup(""); });
  return {attach, start, incoming: incomingCall, reset: (message = "") => cleanup(call || incoming ? message : ""), supported};
};
