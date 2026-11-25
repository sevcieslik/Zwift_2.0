// Group voice chat: WebRTC peer-to-peer mesh, signalling over Socket.IO.
// Fine for a club ride of up to ~10 people with voice on.

export class Voice extends EventTarget {
  constructor(socket, iceServers) {
    super();
    this.socket = socket;
    this.iceServers = iceServers;
    this.peers = new Map(); // id -> { pc, audio, analyser }
    this.stream = null;
    this.muted = false;
    this.active = false;
    this.ctx = null;
    this.levels = new Map(); // id -> 0..1 ('me' for local)

    socket.on('voice:signal', ({ from, data }) => this._onSignal(from, data));
    socket.on('voice:leave', ({ id }) => this._closePeer(id));
  }

  async join() {
    if (this.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this._watchLevel('me', this.stream);
    this.active = true;
    this.setMuted(false);
    const res = await new Promise((resolve) => this.socket.emit('voice:join', {}, resolve));
    for (const id of res.peers || []) await this._call(id);
    this.dispatchEvent(new Event('change'));
  }

  leave() {
    if (!this.active) return;
    this.socket.emit('voice:leave');
    for (const id of [...this.peers.keys()]) this._closePeer(id);
    this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.active = false;
    this.levels.clear();
    if (this.ctx) this.ctx.close();
    this.ctx = null;
    this.dispatchEvent(new Event('change'));
  }

  setMuted(m) {
    this.muted = m;
    if (this.stream) this.stream.getAudioTracks().forEach((t) => (t.enabled = !m));
    this.socket.emit('voice:mute', m);
    this.dispatchEvent(new Event('change'));
  }

  _makePeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = { pc, audio: null, pending: [] };
    this.peers.set(id, peer);
    this.stream.getTracks().forEach((t) => pc.addTrack(t, this.stream));
    pc.onicecandidate = (e) => {
      if (e.candidate) this.socket.emit('voice:signal', { to: id, data: { candidate: e.candidate } });
    };
    pc.ontrack = (e) => {
      if (peer.audio) return;
      const audio = new Audio();
      audio.autoplay = true;
      audio.srcObject = e.streams[0];
      audio.play().catch(() => {});
      peer.audio = audio;
      this._watchLevel(id, e.streams[0]);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        console.warn('Voice connection failed with', id, '- a TURN server may be needed');
        this.dispatchEvent(new CustomEvent('failed', { detail: id }));
      }
    };
    return peer;
  }

  async _call(id) {
    const peer = this._makePeer(id);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.socket.emit('voice:signal', { to: id, data: { sdp: peer.pc.localDescription } });
  }

  async _onSignal(from, data) {
    if (!this.active || !data) return;
    let peer = this.peers.get(from);
    try {
      if (data.sdp) {
        if (data.sdp.type === 'offer') {
          if (peer) this._closePeer(from);
          peer = this._makePeer(from);
          await peer.pc.setRemoteDescription(data.sdp);
          const answer = await peer.pc.createAnswer();
          await peer.pc.setLocalDescription(answer);
          this.socket.emit('voice:signal', { to: from, data: { sdp: peer.pc.localDescription } });
        } else if (peer) {
          await peer.pc.setRemoteDescription(data.sdp);
        }
        if (peer) {
          for (const c of peer.pending) await peer.pc.addIceCandidate(c).catch(() => {});
          peer.pending = [];
        }
      } else if (data.candidate && peer) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.candidate).catch(() => {});
        else peer.pending.push(data.candidate);
      }
    } catch (e) {
      console.warn('Voice signalling error', e);
    }
  }

  _closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    if (peer.audio) { peer.audio.srcObject = null; }
    this.peers.delete(id);
    this.levels.delete(id);
  }

  _watchLevel(id, stream) {
    if (!this.ctx) return;
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      const an = this.ctx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      const tick = () => {
        if (!this.active || (id !== 'me' && !this.peers.has(id))) return;
        an.getByteTimeDomainData(buf);
        let s = 0;
        for (const b of buf) s += (b - 128) ** 2;
        this.levels.set(id, Math.min(1, Math.sqrt(s / buf.length) / 30));
        setTimeout(tick, 100);
      };
      tick();
    } catch (e) { /* level meter is optional */ }
  }

  isSpeaking(id) { return (this.levels.get(id) || 0) > 0.15; }
}
