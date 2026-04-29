/**
 * VoiceChat — 語音聊天模組
 * 使用 PeerJS MediaConnection 建立 P2P 語音 mesh
 */

export class VoiceChat {
  constructor(peer) {
    this.peer = peer; // PeerJS instance
    this.localStream = null;
    this.audioContext = null;
    this.mediaCalls = new Map(); // peerId -> MediaConnection
    this.remoteStreams = new Map(); // peerId -> { stream, audio, gainNode, analyser }
    this.localGainNode = null;
    this.localAnalyser = null;
    this.isMuted = false;
    this._listeners = {};

    // 音量設定
    this.settings = {
      micVolume: 1.0,
      speakerVolume: 0.8,
      sfxVolume: 0.5,
    };

    // 說話偵測
    this._speakingCheckInterval = null;
    this._speakingThreshold = 15; // 音量閾值

    // 監聽來電
    this.peer.on('call', (call) => this._handleIncomingCall(call));
  }

  // ── Event System ──
  on(event, cb) {
    (this._listeners[event] ??= []).push(cb);
  }
  emit(event, data) {
    this._listeners[event]?.forEach((cb) => cb(data));
  }

  // ── 初始化麥克風 ──
  async initMicrophone() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      // 建立 AudioContext 用於音量控制和說話偵測
      this.audioContext = new (window.AudioContext ||
        window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(
        this.localStream
      );

      // 麥克風增益控制
      this.localGainNode = this.audioContext.createGain();
      this.localGainNode.gain.value = this.settings.micVolume;

      // 本地說話偵測
      this.localAnalyser = this.audioContext.createAnalyser();
      this.localAnalyser.fftSize = 256;

      source
        .connect(this.localGainNode)
        .connect(this.localAnalyser)
        .connect(this.audioContext.destination);

      // 開始說話偵測
      this._startSpeakingDetection();

      console.log('[Voice] Microphone initialized');
      return true;
    } catch (err) {
      console.error('[Voice] Failed to get microphone:', err);
      this.emit('mic-error', { error: err.message });
      return false;
    }
  }

  // ── 建立語音 Mesh ──
  async connectToPlayers(peerIds) {
    if (!this.localStream) {
      console.warn('[Voice] No local stream, skipping audio mesh');
      return;
    }

    for (const peerId of peerIds) {
      if (peerId === this.peer.id) continue;
      if (this.mediaCalls.has(peerId)) continue;

      // 只呼叫 ID 排在自己後面的（避免重複連線）
      if (peerId > this.peer.id) {
        this._callPeer(peerId);
      }
    }
  }

  _callPeer(peerId) {
    console.log(`[Voice] Calling ${peerId}`);
    const call = this.peer.call(peerId, this.localStream);
    this.mediaCalls.set(peerId, call);

    call.on('stream', (remoteStream) => {
      this._addRemoteStream(peerId, remoteStream);
    });

    call.on('close', () => {
      this._removeRemoteStream(peerId);
      this.mediaCalls.delete(peerId);
    });

    call.on('error', (err) => {
      console.error(`[Voice] Call error with ${peerId}:`, err);
    });
  }

  _handleIncomingCall(call) {
    if (!this.localStream) {
      console.warn('[Voice] No local stream, cannot answer call');
      return;
    }

    console.log(`[Voice] Incoming call from ${call.peer}`);
    call.answer(this.localStream);
    this.mediaCalls.set(call.peer, call);

    call.on('stream', (remoteStream) => {
      this._addRemoteStream(call.peer, remoteStream);
    });

    call.on('close', () => {
      this._removeRemoteStream(call.peer);
      this.mediaCalls.delete(call.peer);
    });
  }

  // ── 管理遠端音訊流 ──
  _addRemoteStream(peerId, stream) {
    // 移除舊的
    this._removeRemoteStream(peerId);

    // 建立 audio 元素
    const audio = new Audio();
    audio.srcObject = stream;
    audio.volume = this.settings.speakerVolume;
    audio.play().catch((e) => console.warn('[Voice] Auto-play blocked:', e));

    // 建立 analyser 用於偵測對方是否在說話
    let analyser = null;
    try {
      const ctx = this.audioContext;
      if (ctx) {
        const source = ctx.createMediaStreamSource(stream);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
      }
    } catch (e) {
      console.warn('[Voice] Could not create analyser for remote stream');
    }

    this.remoteStreams.set(peerId, { stream, audio, analyser });
    console.log(`[Voice] Added remote stream from ${peerId}`);
    this.emit('stream-added', { peerId });
  }

  _removeRemoteStream(peerId) {
    const remote = this.remoteStreams.get(peerId);
    if (remote) {
      remote.audio.pause();
      remote.audio.srcObject = null;
      this.remoteStreams.delete(peerId);
      this.emit('stream-removed', { peerId });
    }
  }

  // ── 說話偵測 ──
  _startSpeakingDetection() {
    const dataArray = new Uint8Array(
      this.localAnalyser.frequencyBinCount
    );

    this._speakingCheckInterval = setInterval(() => {
      // 偵測本地說話
      this.localAnalyser.getByteFrequencyData(dataArray);
      const localAvg =
        dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
      const localSpeaking =
        localAvg > this._speakingThreshold && !this.isMuted;
      this.emit('speaking-local', { speaking: localSpeaking, volume: localAvg });

      // 偵測遠端說話
      this.remoteStreams.forEach((remote, peerId) => {
        if (remote.analyser) {
          const remoteData = new Uint8Array(
            remote.analyser.frequencyBinCount
          );
          remote.analyser.getByteFrequencyData(remoteData);
          const remoteAvg =
            remoteData.reduce((a, b) => a + b, 0) / remoteData.length;
          const remoteSpeaking = remoteAvg > this._speakingThreshold;
          this.emit('speaking-remote', {
            peerId,
            speaking: remoteSpeaking,
            volume: remoteAvg,
          });
        }
      });
    }, 150);
  }

  // ── 控制 ──
  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted;
      });
    }
    this.emit('mute-changed', { muted: this.isMuted });
    return this.isMuted;
  }

  setMicVolume(value) {
    this.settings.micVolume = value;
    if (this.localGainNode) {
      this.localGainNode.gain.value = value;
    }
  }

  setSpeakerVolume(value) {
    this.settings.speakerVolume = value;
    this.remoteStreams.forEach((remote) => {
      remote.audio.volume = value;
    });
  }

  setSfxVolume(value) {
    this.settings.sfxVolume = value;
  }

  // ── 音效 ──
  playSfx(type) {
    if (!this.audioContext || this.settings.sfxVolume === 0) return;

    const ctx = this.audioContext;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = this.settings.sfxVolume * 0.3;

    osc.connect(gain).connect(ctx.destination);

    switch (type) {
      case 'join':
        osc.frequency.value = 600;
        osc.type = 'sine';
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
        break;
      case 'start':
        osc.frequency.value = 440;
        osc.type = 'sine';
        osc.frequency.linearRampToValueAtTime(880, ctx.currentTime + 0.2);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.4);
        break;
      case 'vote':
        osc.frequency.value = 300;
        osc.type = 'triangle';
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.2);
        break;
      case 'eliminate':
        osc.frequency.value = 500;
        osc.type = 'sawtooth';
        osc.frequency.linearRampToValueAtTime(100, ctx.currentTime + 0.5);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.6);
        break;
      case 'turn':
        osc.frequency.value = 600;
        osc.type = 'sine';
        osc.frequency.linearRampToValueAtTime(800, ctx.currentTime + 0.1);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
        break;
      case 'win':
        osc.frequency.value = 523;
        osc.type = 'sine';
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc.start(ctx.currentTime);
        setTimeout(() => {
          const osc2 = ctx.createOscillator();
          const g2 = ctx.createGain();
          g2.gain.value = this.settings.sfxVolume * 0.3;
          osc2.connect(g2).connect(ctx.destination);
          osc2.frequency.value = 659;
          osc2.type = 'sine';
          g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
          osc2.start(ctx.currentTime);
          osc2.stop(ctx.currentTime + 0.6);
        }, 200);
        osc.stop(ctx.currentTime + 0.8);
        break;
      case 'tick':
        osc.frequency.value = 800;
        osc.type = 'sine';
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.05);
        break;
    }
  }

  // ── 清除遠端（某玩家離開時） ──
  removePlayer(peerId) {
    this._removeRemoteStream(peerId);
    const call = this.mediaCalls.get(peerId);
    if (call) {
      call.close();
      this.mediaCalls.delete(peerId);
    }
  }

  // ── 銷毀 ──
  destroy() {
    clearInterval(this._speakingCheckInterval);
    this.remoteStreams.forEach((_, peerId) => this._removeRemoteStream(peerId));
    this.mediaCalls.forEach((call) => call.close());
    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => t.stop());
    }
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}
