/**
 * App — 主程式入口
 * 整合所有模組，處理路由和事件
 */
import { PeerManager } from './peer-manager.js';
import { VoiceChat } from './voice-chat.js';
import { GameEngine } from './game-engine.js';
import { UI } from './ui.js';

class App {
  constructor() {
    this.pm = null;
    this.vc = null;
    this.engine = null;
    this.ui = new UI();
    this.myNickname = '';
    this.myPeerId = '';
    this.isHost = false;
    this.players = [];
  }

  init() {
    // 檢查 URL hash 是否有房間碼
    const hash = window.location.hash.slice(1);
    if (hash) {
      document.getElementById('input-room-code').value = hash;
      document.getElementById('join-section').classList.add('highlight');
    }

    // 首頁事件
    this.ui.initHome(
      () => this._createRoom(),
      (code, nick) => this._joinRoom(code, nick)
    );

    // 聊天按鈕
    document.getElementById('btn-chat-toggle').addEventListener('click', () => {
      this.ui.toggleChat();
      document.getElementById('chat-badge').classList.remove('show');
    });

    // 聊天發送
    document.getElementById('btn-chat-send').addEventListener('click', () => this._sendChat());
    document.getElementById('chat-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._sendChat();
    });

    // 設定按鈕
    document.getElementById('btn-settings').addEventListener('click', () => this.ui.toggleSettings());

    // 音量滑桿
    document.getElementById('slider-mic').addEventListener('input', (e) => {
      if (this.vc) this.vc.setMicVolume(e.target.value / 100);
    });
    document.getElementById('slider-speaker').addEventListener('input', (e) => {
      if (this.vc) this.vc.setSpeakerVolume(e.target.value / 100);
    });
    document.getElementById('slider-sfx').addEventListener('input', (e) => {
      if (this.vc) this.vc.setSfxVolume(e.target.value / 100);
    });

    // 靜音按鈕
    document.getElementById('btn-mute').addEventListener('click', () => {
      if (this.vc) {
        const muted = this.vc.toggleMute();
        document.getElementById('btn-mute').textContent = muted ? '🔇 已靜音' : '🎤 麥克風';
        document.getElementById('btn-mute').classList.toggle('muted', muted);
      }
    });
  }

  // ── 建立房間 ──
  async _createRoom() {
    const nickname = document.getElementById('input-host-nickname').value.trim();
    if (!nickname) { this.ui.showToast('請輸入暱稱'); return; }

    this.myNickname = nickname;
    this.isHost = true;
    this.ui.showLoading('建立房間中...');

    try {
      this.pm = new PeerManager();
      const roomCode = await this.pm.createRoom();
      this.myPeerId = this.pm.myPeerId;

      // 建立遊戲引擎
      this.engine = new GameEngine(this.pm);
      this._setupHostEvents();

      // Host 自己加入玩家列表
      this.engine.addPlayer(this.myPeerId, nickname);

      this.ui.hideLoading();
      this.ui.showLobby(roomCode, this.pm.getInviteUrl(), true);

      // 更新 URL hash 以便分享
      window.location.hash = roomCode;

      // 非阻塞初始化語音
      this._initVoice();

      // 開始遊戲按鈕
      document.getElementById('btn-start-game').onclick = () => {
        if (this.engine.state.players.length >= 3) {
          this.engine.startGame();
          if (this.vc) this.vc.playSfx('start');
        }
      };

    } catch (err) {
      this.ui.hideLoading();
      this.ui.showToast('建立房間失敗：' + err.message);
    }
  }

  // ── 加入房間 ──
  async _joinRoom(roomCode, nickname) {
    this.myNickname = nickname;
    this.isHost = false;
    this.ui.showLoading('加入房間中...');

    try {
      this.pm = new PeerManager();
      await this.pm.joinRoom(roomCode, nickname);
      this.myPeerId = this.pm.myPeerId;

      this._setupClientEvents();

      this.ui.hideLoading();
      this.ui.showLobby(roomCode, this.pm.getInviteUrl(), false);

      // 非阻塞初始化語音
      this._initVoice();

    } catch (err) {
      this.ui.hideLoading();
      this.ui.showToast('加入失敗：' + err.message);
    }
  }

  // ── 初始化語音 ──
  async _initVoice() {
    this.vc = new VoiceChat(this.pm.peer);
    const ok = await this.vc.initMicrophone();
    if (!ok) {
      this.ui.showToast('無法存取麥克風，語音功能將停用');
    }
    // 說話指示燈
    this.vc.on('speaking-local', ({ speaking }) => {
      this.ui.updateSpeakingIndicator(this.myNickname, speaking);
    });
    this.vc.on('speaking-remote', ({ peerId, speaking }) => {
      const p = this.players.find(pp => pp.peerId === peerId);
      if (p) this.ui.updateSpeakingIndicator(p.nickname, speaking);
    });
  }

  // ── Host 事件 ──
  _setupHostEvents() {
    // 新玩家加入
    this.pm.on('player-joined', ({ peerId, nickname }) => {
      this.engine.addPlayer(peerId, nickname);
      if (this.vc) this.vc.playSfx('join');
    });

    // 玩家斷線
    this.pm.on('player-disconnected', ({ peerId }) => {
      this.engine.removePlayer(peerId);
      if (this.vc) this.vc.removePlayer(peerId);
    });

    // 收到玩家訊息
    this.pm.on('message', (data) => {
      switch (data.type) {
        case 'DONE_SPEAKING':
          this.engine.handleDoneSpeaking(data.fromPeerId);
          break;
        case 'VOTE':
          this.engine.handleVote(data.fromPeerId, data.targetPeerId);
          break;
        case 'TOPIC_VOTE':
          this.engine.handleTopicVote(data.fromPeerId, data.topicIndex);
          break;
        case 'CHAT_MSG':
          this.engine.handleChat(data.fromPeerId, data.text);
          break;
      }
    });

    // 遊戲引擎事件
    this.engine.on('lobby-update', ({ players }) => {
      this.players = players;
      this.ui.updatePlayerList(players);
    });

    // 主題投票事件
    this.engine.on('topic-vote-start', (data) => {
      this.ui.showTopicVote(data.topics, (topicIndex) => {
        this.engine.handleTopicVote(this.myPeerId, topicIndex);
      });
    });

    this.engine.on('topic-vote-progress', (data) => {
      this.ui.updateTopicVoteProgress(data.votedCount, data.totalCount);
    });

    this.engine.on('topic-vote-result', (data) => {
      this.ui.showTopicVoteResult(data.winnerIndex, data.category);
    });

    this.engine.on('game-start-self', (data) => {
      // Host 自己的遊戲開始
      this._connectAudioMesh(data.peerIds);
      this.ui.setGameHint(data.category);
      this.ui.showWordReveal(data.role, data.word, data.category, data.spyCount);
    });

    this.engine.on('think-timer', ({ timeLeft }) => {
      const el = document.getElementById('think-countdown');
      if (el) {
        el.textContent = timeLeft > 0 ? `思考時間：${timeLeft} 秒` : '發言即將開始...';
        if (timeLeft <= 3) el.style.color = 'var(--red)';
      }
    });

    this.engine.on('turn-update', (data) => {
      if (data.currentSpeaker === this.myNickname && this.vc) {
        this.vc.playSfx('turn');
      }
      this.ui.showSpeaking(data, this.myNickname);
      this._setupDoneSpeakingBtn(true);
    });

    this.engine.on('timer-sync', ({ timeLeft }) => {
      this.ui.updateTimer(timeLeft);
    });

    this.engine.on('vote-start', (data) => {
      if (this.vc) this.vc.playSfx('vote');
      const me = this.engine.state.players.find(p => p.isHost);
      if (me && me.isAlive) {
        this.ui.showVoting(data.alivePlayers, this.myPeerId, (targetPeerId) => {
          this.engine.handleVote(this.myPeerId, targetPeerId);
        });
      }
    });

    this.engine.on('vote-progress', (data) => {
      this.ui.updateVoteProgress(data.votedCount, data.totalCount);
    });

    this.engine.on('vote-result', (data) => {
      if (data.eliminated && this.vc) this.vc.playSfx('eliminate');
      this.ui.showVoteResult(data);
    });

    this.engine.on('game-over', (data) => {
      if (this.vc) this.vc.playSfx('win');
      this.ui.showGameOver(data,
        () => this.engine.restartGame(),
        () => window.location.reload()
      );
    });

    this.engine.on('restart', () => {
      this.ui.showLobby(this.pm.roomCode, this.pm.getInviteUrl(), true);
    });

    this.engine.on('chat-msg', (msg) => {
      this.ui.addChatMessage(msg);
    });

    this.engine.on('player-added', () => {
      if (this.vc) this.vc.playSfx('join');
    });
  }

  // ── Client 事件 ──
  _setupClientEvents() {
    this.pm.on('message', (data) => {
      switch (data.type) {
        case 'LOBBY_UPDATE':
          this.players = data.players;
          this.ui.updatePlayerList(data.players);
          break;

        case 'TOPIC_VOTE_START':
          this.ui.showTopicVote(data.topics, (topicIndex) => {
            this.pm.sendToHost({ type: 'TOPIC_VOTE', topicIndex });
          });
          break;

        case 'TOPIC_VOTE_PROGRESS':
          this.ui.updateTopicVoteProgress(data.votedCount, data.totalCount);
          break;

        case 'TOPIC_VOTE_RESULT':
          this.ui.showTopicVoteResult(data.winnerIndex, data.category);
          break;

        case 'GAME_START':
          this._connectAudioMesh(data.peerIds);
          if (this.vc) this.vc.playSfx('start');
          this.ui.setGameHint(data.category);
          this.ui.showWordReveal(data.role, data.word, data.category, data.spyCount);
          this.ui._myRole = data.role;
          this.ui._myWord = data.word;
          break;

        case 'THINK_TIMER': {
          const el = document.getElementById('think-countdown');
          if (el) {
            el.textContent = data.timeLeft > 0 ? `思考時間：${data.timeLeft} 秒` : '發言即將開始...';
            if (data.timeLeft <= 3) el.style.color = 'var(--red)';
          }
          break;
        }

        case 'TURN_UPDATE':
          if (data.currentSpeaker === this.myNickname && this.vc) {
            this.vc.playSfx('turn');
          }
          this.ui.showSpeaking(data, this.myNickname);
          this._setupDoneSpeakingBtn(false);
          break;

        case 'TIMER_SYNC':
          this.ui.updateTimer(data.timeLeft);
          break;

        case 'VOTE_START':
          if (this.vc) this.vc.playSfx('vote');
          this.ui.showVoting(data.alivePlayers, this.myPeerId, (targetPeerId) => {
            this.pm.sendToHost({ type: 'VOTE', targetPeerId });
          });
          break;

        case 'VOTE_PROGRESS':
          this.ui.updateVoteProgress(data.votedCount, data.totalCount);
          break;

        case 'VOTE_RESULT':
          if (data.eliminated && this.vc) this.vc.playSfx('eliminate');
          this.ui.showVoteResult(data);
          break;

        case 'GAME_OVER':
          if (this.vc) this.vc.playSfx('win');
          this.ui.showGameOver(data,
            () => { /* client can't restart */ this.ui.showToast('等待房主重新開始...'); },
            () => window.location.reload()
          );
          break;

        case 'RESTART':
          this.ui.showLobby(this.pm.roomCode, this.pm.getInviteUrl(), false);
          break;

        case 'CHAT_MSG':
          this.ui.addChatMessage(data);
          break;
      }
    });

    this.pm.on('disconnected', () => {
      this.ui.showToast('與房主的連線已斷開');
    });

    this.pm.on('error', ({ message }) => {
      this.ui.showToast(message);
    });
  }

  // ── 發言完畢按鈕 ──
  _setupDoneSpeakingBtn(isHostMode) {
    document.getElementById('btn-done-speaking').onclick = () => {
      if (isHostMode) {
        this.engine.handleDoneSpeaking(this.myPeerId);
      } else {
        this.pm.sendToHost({ type: 'DONE_SPEAKING' });
      }
      document.getElementById('btn-done-speaking').disabled = true;
    };
  }

  // ── 語音 Mesh ──
  _connectAudioMesh(peerIds) {
    if (this.vc) {
      this.vc.connectToPlayers(peerIds);
    }
  }

  // ── 發送聊天 ──
  _sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (this.isHost) {
      this.engine.handleChat(this.myPeerId, text);
    } else {
      this.pm.sendToHost({ type: 'CHAT_MSG', text });
    }
  }
}

// 啟動
const app = new App();
app.init();
