/**
 * PeerManager — PeerJS 連線管理模組
 * 處理房間建立、加入、訊息收發
 */

export class PeerManager {
  constructor() {
    this.peer = null;
    this.connections = new Map(); // peerId -> DataConnection
    this.isHost = false;
    this.roomCode = '';
    this.myPeerId = '';
    this.myNickname = '';
    this.hostConnection = null; // client only
    this._listeners = {};
    this._peerReady = null;
  }

  // ── Event System ──
  on(event, cb) {
    (this._listeners[event] ??= []).push(cb);
  }

  emit(event, data) {
    this._listeners[event]?.forEach((cb) => cb(data));
  }

  off(event, cb) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter((f) => f !== cb);
    }
  }

  // ── 生成房間碼 ──
  static generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  static roomCodeToPeerId(code) {
    return `spygame-${code}`;
  }

  // ── 建立房間（Host） ──
  async createRoom() {
    this.isHost = true;
    this.roomCode = PeerManager.generateRoomCode();
    const peerId = PeerManager.roomCodeToPeerId(this.roomCode);

    await this._createPeer(peerId);

    // 監聽新玩家連入
    this.peer.on('connection', (conn) => {
      this._setupConnection(conn);
    });

    console.log(`[Host] Room created: ${this.roomCode}, PeerID: ${peerId}`);
    return this.roomCode;
  }

  // ── 加入房間（Client） ──
  async joinRoom(roomCode, nickname) {
    this.isHost = false;
    this.roomCode = roomCode;
    this.myNickname = nickname;

    await this._createPeer(); // random ID

    const hostPeerId = PeerManager.roomCodeToPeerId(roomCode);
    const conn = this.peer.connect(hostPeerId, { reliable: true, serialization: 'json' });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('連線逾時，請確認房間碼是否正確，或房主已離開'));
      }, 15000);

      conn.on('open', () => {
        clearTimeout(timeout);
        this.hostConnection = conn;
        this._setupHostConnection(conn);

        // 發送加入請求
        conn.send({ type: 'JOIN', nickname, peerId: this.myPeerId });
        resolve();
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        console.error('[Client] Join error:', err);
        reject(new Error('無法連線到房間：' + (err.message || '連線被拒絕')));
      });
    });
  }

  // ── 建立 PeerJS 實例 ──
  _createPeer(id) {
    return new Promise((resolve, reject) => {
      const opts = {
        debug: 1,
        secure: true,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
            {
              urls: 'turn:openrelay.metered.ca:80',
              username: 'openrelayproject',
              credential: 'openrelayproject',
            },
            {
              urls: 'turn:openrelay.metered.ca:443',
              username: 'openrelayproject',
              credential: 'openrelayproject',
            },
            {
              urls: 'turn:openrelay.metered.ca:443?transport=tcp',
              username: 'openrelayproject',
              credential: 'openrelayproject',
            },
          ],
        },
      };

      this.peer = id ? new Peer(id, opts) : new Peer(opts);

      this.peer.on('open', (peerId) => {
        this.myPeerId = peerId;
        console.log(`[Peer] Connected with ID: ${peerId}`);
        resolve(peerId);
      });

      this.peer.on('error', (err) => {
        console.error('[Peer] Error:', err);
        if (err.type === 'unavailable-id') {
          reject(new Error('房間碼已被使用，請重試'));
        } else if (err.type === 'peer-unavailable') {
          this.emit('error', { message: '找不到該房間，請確認房間碼' });
        } else {
          reject(err);
        }
      });

      this.peer.on('disconnected', () => {
        console.log('[Peer] Disconnected from signaling server');
        // 嘗試重連
        if (!this.peer.destroyed) {
          this.peer.reconnect();
        }
      });
    });
  }

  // ── Host: 設定新連線 ──
  _setupConnection(conn) {
    conn.on('open', () => {
      console.log(`[Host] Player connected: ${conn.peer}`);
    });

    conn.on('data', (data) => {
      this._handleMessage(data, conn);
    });

    conn.on('close', () => {
      console.log(`[Host] Player disconnected: ${conn.peer}`);
      this.connections.delete(conn.peer);
      this.emit('player-disconnected', { peerId: conn.peer });
    });

    conn.on('error', (err) => {
      console.error(`[Host] Connection error with ${conn.peer}:`, err);
    });
  }

  // ── Client: 設定與 Host 的連線 ──
  _setupHostConnection(conn) {
    conn.on('data', (data) => {
      this.emit('message', data);
    });

    conn.on('close', () => {
      console.log('[Client] Disconnected from host');
      this.emit('disconnected', {});
    });

    conn.on('error', (err) => {
      console.error('[Client] Connection error:', err);
    });
  }

  // ── Host: 處理收到的訊息 ──
  _handleMessage(data, conn) {
    if (data.type === 'JOIN') {
      // 記錄連線
      this.connections.set(conn.peer, conn);
      this.emit('player-joined', {
        peerId: conn.peer,
        nickname: data.nickname,
      });
    } else {
      // 轉發其他訊息給遊戲引擎
      this.emit('message', { ...data, fromPeerId: conn.peer });
    }
  }

  // ── 發送訊息 ──
  sendToHost(data) {
    if (this.hostConnection && this.hostConnection.open) {
      this.hostConnection.send(data);
    }
  }

  sendToPlayer(peerId, data) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) {
      conn.send(data);
    }
  }

  broadcast(data) {
    this.connections.forEach((conn) => {
      if (conn.open) {
        conn.send(data);
      }
    });
  }

  // ── 取得邀請連結 ──
  getInviteUrl() {
    const base = window.location.origin + window.location.pathname;
    return `${base}#${this.roomCode}`;
  }

  // ── 取得所有連線的 Peer ID ──
  getConnectedPeerIds() {
    return Array.from(this.connections.keys());
  }

  // ── 銷毀 ──
  destroy() {
    if (this.peer && !this.peer.destroyed) {
      this.peer.destroy();
    }
  }
}
