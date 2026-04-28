import { getRandomWordPair } from './word-bank.js';

export class GameEngine {
  constructor(peerManager) {
    this.pm = peerManager;
    this._listeners = {};
    this.state = {
      phase: 'lobby',
      players: [],
      wordPair: null,
      speakingOrder: [],
      currentSpeakerIndex: 0,
      currentRound: 1,
      totalRoundsBeforeVote: 2,
      speakingTime: 30,
      votingTime: 15,
      timer: null,
      timeLeft: 0,
      votes: {},
      chatLog: [],
    };
  }

  on(event, cb) { (this._listeners[event] ??= []).push(cb); }
  emit(event, data) { this._listeners[event]?.forEach(cb => cb(data)); }

  addPlayer(peerId, nickname) {
    if (this.state.players.find(p => p.peerId === peerId)) return;
    if (this.state.players.length >= 8) return;
    const isHost = this.state.players.length === 0;
    this.state.players.push({
      peerId, nickname, isHost, isAlive: true,
      role: null, word: null, hasVoted: false, votedFor: null, doneSpeaking: false,
    });
    this._broadcastLobbyUpdate();
    this.emit('player-added', { nickname, playerCount: this.state.players.length });
  }

  removePlayer(peerId) {
    const idx = this.state.players.findIndex(p => p.peerId === peerId);
    if (idx === -1) return;
    const player = this.state.players[idx];
    if (this.state.phase === 'lobby') {
      this.state.players.splice(idx, 1);
      this._broadcastLobbyUpdate();
    } else {
      player.isAlive = false;
      this._broadcastSystemChat(`${player.nickname} 已離開遊戲`);
      this._checkWinCondition();
    }
    this.emit('player-removed', { nickname: player.nickname });
  }

  startGame() {
    if (this.state.players.length < 3) return;
    this.state.wordPair = getRandomWordPair();
    this.state.phase = 'wordReveal';
    const n = this.state.players.length;
    let spyCount = n <= 4 ? 1 : n <= 6 ? (Math.random() < 0.5 ? 1 : 2) : 2;
    const indices = this.state.players.map((_, i) => i);
    this._shuffle(indices);
    const spyIndices = new Set(indices.slice(0, spyCount));
    this.state.players.forEach((p, i) => {
      p.isAlive = true;
      p.role = spyIndices.has(i) ? 'spy' : 'civilian';
      p.word = spyIndices.has(i) ? this.state.wordPair.spy : this.state.wordPair.civilian;
      p.hasVoted = false; p.votedFor = null; p.doneSpeaking = false;
    });
    this._generateSpeakingOrder();
    this.state.currentRound = 1;
    this.state.currentSpeakerIndex = 0;
    const peerIds = this.state.players.map(pp => pp.peerId);
    this.state.players.forEach(p => {
      const data = {
        type: 'GAME_START', role: p.role, word: p.word, peerIds, spyCount,
        category: this.state.wordPair.category,
        speakingOrder: this.state.speakingOrder.map(idx => this.state.players[idx].nickname),
      };
      if (p.isHost) this.emit('game-start-self', data);
      else this.pm.sendToPlayer(p.peerId, data);
    });

    // 15 秒思考倒數
    let thinkTime = 15;
    const thinkTimer = setInterval(() => {
      thinkTime--;
      this.pm.broadcast({ type: 'THINK_TIMER', timeLeft: thinkTime });
      this.emit('think-timer', { timeLeft: thinkTime });
      if (thinkTime <= 0) {
        clearInterval(thinkTimer);
        this._startSpeakingPhase();
      }
    }, 1000);
  }

  _startSpeakingPhase() {
    this.state.phase = 'speaking';
    this.state.currentSpeakerIndex = 0;
    this._generateSpeakingOrder();
    this.state.players.forEach(p => { p.doneSpeaking = false; });
    this._startCurrentSpeakerTurn();
  }

  _startCurrentSpeakerTurn() {
    if (this.state.currentSpeakerIndex >= this.state.speakingOrder.length) {
      if (this.state.currentRound >= this.state.totalRoundsBeforeVote) {
        this._startVotingPhase();
      } else {
        this.state.currentRound++;
        this.state.currentSpeakerIndex = 0;
        this.state.players.forEach(p => { p.doneSpeaking = false; });
        this._startCurrentSpeakerTurn();
      }
      return;
    }
    const playerIdx = this.state.speakingOrder[this.state.currentSpeakerIndex];
    const speaker = this.state.players[playerIdx];
    if (!speaker || !speaker.isAlive) {
      this.state.currentSpeakerIndex++;
      this._startCurrentSpeakerTurn();
      return;
    }
    this.state.timeLeft = this.state.speakingTime;
    const turnData = {
      type: 'TURN_UPDATE', phase: 'speaking', currentSpeaker: speaker.nickname,
      currentSpeakerPeerId: speaker.peerId, round: this.state.currentRound,
      totalRounds: this.state.totalRoundsBeforeVote, timeLeft: this.state.timeLeft,
      speakerIndex: this.state.currentSpeakerIndex, totalSpeakers: this.state.speakingOrder.length,
    };
    this.pm.broadcast(turnData);
    this.emit('turn-update', turnData);
    this._startTimer(this.state.speakingTime, () => this._nextSpeaker());
  }

  _nextSpeaker() {
    this._clearTimer();
    this.state.currentSpeakerIndex++;
    this._startCurrentSpeakerTurn();
  }

  handleDoneSpeaking(peerId) {
    const playerIdx = this.state.speakingOrder[this.state.currentSpeakerIndex];
    if (playerIdx === undefined) return;
    const speaker = this.state.players[playerIdx];
    if (!speaker) return;
    if (speaker.peerId === peerId || (this.pm.isHost && speaker.isHost)) {
      speaker.doneSpeaking = true;
      this._nextSpeaker();
    }
  }

  _startVotingPhase() {
    this.state.phase = 'voting';
    this.state.votes = {};
    this.state.players.forEach(p => { p.hasVoted = false; p.votedFor = null; });
    const alivePlayers = this.state.players.filter(p => p.isAlive)
      .map(p => ({ peerId: p.peerId, nickname: p.nickname }));
    const voteData = { type: 'VOTE_START', alivePlayers, timeLeft: this.state.votingTime };
    this.pm.broadcast(voteData);
    this.emit('vote-start', voteData);
    this._startTimer(this.state.votingTime, () => this._countVotes());
  }

  handleVote(voterPeerId, targetPeerId) {
    const voter = this.state.players.find(p => p.peerId === voterPeerId);
    if (!voter || !voter.isAlive || voter.hasVoted) return;
    if (voter.peerId === targetPeerId) return;
    voter.hasVoted = true;
    voter.votedFor = targetPeerId;
    this.state.votes[voter.peerId] = targetPeerId;
    const votedCount = Object.keys(this.state.votes).length;
    const aliveCount = this.state.players.filter(p => p.isAlive).length;
    this.pm.broadcast({ type: 'VOTE_PROGRESS', votedCount, totalCount: aliveCount });
    this.emit('vote-progress', { votedCount, totalCount: aliveCount });
    if (votedCount >= aliveCount) {
      this._clearTimer();
      setTimeout(() => this._countVotes(), 500);
    }
  }

  _countVotes() {
    this._clearTimer();
    this.state.phase = 'voteResult';
    const voteCounts = {};
    Object.values(this.state.votes).forEach(t => { voteCounts[t] = (voteCounts[t] || 0) + 1; });
    let maxVotes = 0, maxPlayers = [];
    Object.entries(voteCounts).forEach(([pid, count]) => {
      if (count > maxVotes) { maxVotes = count; maxPlayers = [pid]; }
      else if (count === maxVotes) maxPlayers.push(pid);
    });
    let eliminated = null, isTie = false;
    if (maxPlayers.length === 1 && maxVotes > 0) {
      const player = this.state.players.find(p => p.peerId === maxPlayers[0]);
      if (player) { player.isAlive = false; eliminated = { peerId: player.peerId, nickname: player.nickname, role: player.role }; }
    } else { isTie = true; }

    const voteDetails = {};
    Object.entries(this.state.votes).forEach(([vPid, tPid]) => {
      const v = this.state.players.find(p => p.peerId === vPid);
      const t = this.state.players.find(p => p.peerId === tPid);
      if (v && t) voteDetails[v.nickname] = t.nickname;
    });
    const gameOver = this._checkWinCondition();
    const resultData = {
      type: 'VOTE_RESULT', eliminated, isTie, voteDetails, gameOver: gameOver !== null, winner: gameOver,
      voteCounts: Object.fromEntries(Object.entries(voteCounts).map(([pid, c]) => {
        const p = this.state.players.find(pp => pp.peerId === pid);
        return [p ? p.nickname : pid, c];
      })),
    };
    this.pm.broadcast(resultData);
    this.emit('vote-result', resultData);
    if (gameOver) setTimeout(() => this._showGameOver(gameOver), 3000);
    else setTimeout(() => { this.state.currentRound = 1; this._startSpeakingPhase(); }, 5000);
  }

  _checkWinCondition() {
    const alive = this.state.players.filter(p => p.isAlive);
    const spies = alive.filter(p => p.role === 'spy');
    const civs = alive.filter(p => p.role === 'civilian');
    if (spies.length === 0) return 'civilians';
    if (spies.length >= civs.length) return 'spies';
    return null;
  }

  _showGameOver(winner) {
    this.state.phase = 'gameOver';
    const allPlayers = this.state.players.map(p => ({
      nickname: p.nickname, role: p.role, word: p.word, isAlive: p.isAlive, peerId: p.peerId,
    }));
    const overData = {
      type: 'GAME_OVER', winner, players: allPlayers,
      civilianWord: this.state.wordPair.civilian, spyWord: this.state.wordPair.spy,
      category: this.state.wordPair.category,
    };
    this.pm.broadcast(overData);
    this.emit('game-over', overData);
  }

  restartGame() {
    this.state.phase = 'lobby';
    this.state.players.forEach(p => {
      p.isAlive = true; p.role = null; p.word = null;
      p.hasVoted = false; p.votedFor = null; p.doneSpeaking = false;
    });
    this.state.wordPair = null; this.state.votes = {};
    this.state.currentRound = 1; this._clearTimer();
    this.pm.broadcast({ type: 'RESTART' });
    this.emit('restart', {});
    this._broadcastLobbyUpdate();
  }

  handleChat(peerId, text) {
    const player = this.state.players.find(p => p.peerId === peerId);
    if (!player) return;
    const msg = { type: 'CHAT_MSG', from: player.nickname, text, timestamp: Date.now(), isSystem: false };
    this.state.chatLog.push(msg);
    this.pm.broadcast(msg);
    this.emit('chat-msg', msg);
  }

  _broadcastSystemChat(text) {
    const msg = { type: 'CHAT_MSG', from: '系統', text, timestamp: Date.now(), isSystem: true };
    this.state.chatLog.push(msg);
    this.pm.broadcast(msg);
    this.emit('chat-msg', msg);
  }

  _startTimer(seconds, onComplete) {
    this._clearTimer();
    this.state.timeLeft = seconds;
    this.state.timer = setInterval(() => {
      this.state.timeLeft--;
      this.pm.broadcast({ type: 'TIMER_SYNC', timeLeft: this.state.timeLeft });
      this.emit('timer-sync', { timeLeft: this.state.timeLeft });
      if (this.state.timeLeft <= 0) { this._clearTimer(); onComplete(); }
    }, 1000);
  }

  _clearTimer() {
    if (this.state.timer) { clearInterval(this.state.timer); this.state.timer = null; }
  }

  _broadcastLobbyUpdate() {
    const players = this.state.players.map(p => ({ peerId: p.peerId, nickname: p.nickname, isHost: p.isHost }));
    this.pm.broadcast({ type: 'LOBBY_UPDATE', players });
    this.emit('lobby-update', { players });
  }

  _generateSpeakingOrder() {
    const aliveIndices = this.state.players.map((p, i) => p.isAlive ? i : -1).filter(i => i !== -1);
    this._shuffle(aliveIndices);
    this.state.speakingOrder = aliveIndices;
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }
}
