/**
 * UI — 畫面渲染模組
 */
export class UI {
  constructor() {
    this.currentScreen = 'home';
    this.chatOpen = false;
    this.settingsOpen = false;
    this._chatMessages = [];
    this._myRole = null;
    this._myWord = null;
    this._wordRevealed = false;
  }

  // ── 畫面切換 ──
  showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    const target = document.getElementById(`screen-${screenId}`);
    if (target) {
      target.classList.add('active');
      this.currentScreen = screenId;
    }
  }

  // ── 首頁 ──
  initHome(onCreateRoom, onJoinRoom) {
    document.getElementById('btn-create').addEventListener('click', onCreateRoom);
    document.getElementById('btn-join').addEventListener('click', () => {
      const nickname = document.getElementById('input-nickname').value.trim();
      const roomCode = document.getElementById('input-room-code').value.trim().toUpperCase();
      if (!nickname) { this.showToast('請輸入暱稱'); return; }
      if (!roomCode) { this.showToast('請輸入房間碼'); return; }
      onJoinRoom(roomCode, nickname);
    });
  }

  // ── 等待室 ──
  showLobby(roomCode, inviteUrl, isHost) {
    document.getElementById('lobby-room-code').textContent = roomCode;
    document.getElementById('lobby-invite-url').textContent = inviteUrl;
    document.getElementById('btn-copy-invite').onclick = () => {
      navigator.clipboard.writeText(inviteUrl).then(() => this.showToast('已複製邀請連結！'));
    };
    const startBtn = document.getElementById('btn-start-game');
    startBtn.style.display = isHost ? '' : 'none';
    this.showScreen('lobby');
  }

  updatePlayerList(players) {
    const list = document.getElementById('player-list');
    list.innerHTML = '';
    const avatars = ['🦊','🐱','🐶','🐸','🐼','🦁','🐧','🐨'];
    players.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'player-card';
      div.innerHTML = `
        <span class="player-avatar">${avatars[i % avatars.length]}</span>
        <span class="player-name">${p.nickname}</span>
        ${p.isHost ? '<span class="host-badge">👑</span>' : ''}
      `;
      list.appendChild(div);
    });
    document.getElementById('player-count').textContent = `${players.length} / 8`;
    const startBtn = document.getElementById('btn-start-game');
    if (startBtn.style.display !== 'none') {
      startBtn.disabled = players.length < 3;
    }
  }

  // ── 查看詞牌 ──
  showWordReveal(role, word, category, spyCount) {
    this._myRole = role;
    this._myWord = word;
    this._wordRevealed = false;
    const roleText = role === 'spy' ? '🕵️ 你是間諜' : '👤 你是平民';
    const roleClass = role === 'spy' ? 'role-spy' : 'role-civilian';
    document.getElementById('word-role').textContent = roleText;
    document.getElementById('word-role').className = `word-role ${roleClass}`;
    document.getElementById('word-category').textContent = `類別：${category}`;
    document.getElementById('word-spy-count').textContent = `本局有 ${spyCount} 名間諜`;
    document.getElementById('word-text').textContent = '點擊翻牌查看';
    document.getElementById('word-text').classList.remove('revealed');
    const card = document.getElementById('word-card');
    card.classList.remove('flipped');
    card.onclick = () => {
      if (!this._wordRevealed) {
        this._wordRevealed = true;
        card.classList.add('flipped');
        document.getElementById('word-text').textContent = word;
        document.getElementById('word-text').classList.add('revealed');
      }
    };
    this.showScreen('word-reveal');
  }

  // ── 發言階段 ──
  showSpeaking(data, myNickname) {
    const isMyTurn = data.currentSpeaker === myNickname;
    document.getElementById('speaking-current').textContent = isMyTurn
      ? '🎤 輪到你發言！' : `🎤 ${data.currentSpeaker} 正在發言`;
    document.getElementById('speaking-current').className = isMyTurn ? 'speaking-turn my-turn' : 'speaking-turn';
    document.getElementById('speaking-round').textContent = `第 ${data.round} / ${data.totalRounds} 輪`;
    document.getElementById('speaking-progress').textContent =
      `發言者 ${data.speakerIndex + 1} / ${data.totalSpeakers}`;
    document.getElementById('btn-done-speaking').style.display = isMyTurn ? '' : 'none';
    document.getElementById('btn-done-speaking').disabled = false;
    document.getElementById('my-word-reminder').textContent = `我的詞：${this._myWord}`;
    this.showScreen('speaking');
  }

  updateTimer(timeLeft) {
    // Speaking timer
    const speakTimer = document.getElementById('timer-value');
    const voteTimer = document.getElementById('vote-timer-value');
    const activeTimer = this.currentScreen === 'voting' ? voteTimer : speakTimer;
    if (activeTimer) {
      activeTimer.textContent = timeLeft;
      activeTimer.className = timeLeft <= 5 ? 'timer-value urgent' : 'timer-value';
    }
    // 更新圓環
    const speakCircle = document.getElementById('timer-circle');
    const voteCircle = document.getElementById('vote-timer-circle');
    const activeCircle = this.currentScreen === 'voting' ? voteCircle : speakCircle;
    if (activeCircle) {
      const total = this.currentScreen === 'voting' ? 15 : 30;
      const pct = timeLeft / total;
      const circumference = 2 * Math.PI * 45;
      activeCircle.style.strokeDashoffset = circumference * (1 - pct);
    }
  }

  // ── 投票階段 ──
  showVoting(alivePlayers, myPeerId, onVote) {
    const list = document.getElementById('vote-player-list');
    list.innerHTML = '';
    const avatars = ['🦊','🐱','🐶','🐸','🐼','🦁','🐧','🐨'];
    let selected = null;
    alivePlayers.forEach((p, i) => {
      if (p.peerId === myPeerId) return; // 不能投自己
      const div = document.createElement('div');
      div.className = 'vote-card';
      div.innerHTML = `<span class="player-avatar">${avatars[i % avatars.length]}</span><span>${p.nickname}</span>`;
      div.onclick = () => {
        list.querySelectorAll('.vote-card').forEach(c => c.classList.remove('selected'));
        div.classList.add('selected');
        selected = p.peerId;
      };
      list.appendChild(div);
    });
    document.getElementById('btn-confirm-vote').onclick = () => {
      if (selected) {
        onVote(selected);
        document.getElementById('btn-confirm-vote').disabled = true;
        this.showToast('已投票！等待其他人...');
      } else {
        this.showToast('請選擇投票對象');
      }
    };
    document.getElementById('btn-confirm-vote').disabled = false;
    document.getElementById('vote-progress-text').textContent = '等待投票中...';
    this.showScreen('voting');
  }

  updateVoteProgress(votedCount, totalCount) {
    document.getElementById('vote-progress-text').textContent = `已投票：${votedCount} / ${totalCount}`;
  }

  // ── 投票結果 ──
  showVoteResult(data) {
    const container = document.getElementById('vote-result-content');
    let html = '<div class="vote-result-details">';
    if (data.isTie) {
      html += '<h3 class="result-tie">⚖️ 平票！本輪無人淘汰</h3>';
    } else if (data.eliminated) {
      const roleEmoji = data.eliminated.role === 'spy' ? '🕵️' : '👤';
      const roleText = data.eliminated.role === 'spy' ? '間諜' : '平民';
      html += `<h3 class="result-eliminated">${data.eliminated.nickname} 被淘汰了！</h3>`;
      html += `<p class="result-role">身份：${roleEmoji} ${roleText}</p>`;
    }
    // 票數明細
    html += '<div class="vote-breakdown"><h4>投票明細</h4>';
    Object.entries(data.voteDetails || {}).forEach(([voter, target]) => {
      html += `<div class="vote-row"><span>${voter}</span><span>→</span><span>${target}</span></div>`;
    });
    html += '</div>';
    if (data.gameOver) {
      html += `<p class="game-over-preview">${data.winner === 'civilians' ? '平民陣營獲勝！' : '間諜陣營獲勝！'}</p>`;
    } else {
      html += '<p class="next-round-hint">即將進入下一輪...</p>';
    }
    html += '</div>';
    container.innerHTML = html;
    this.showScreen('vote-result');
  }

  // ── 遊戲結果 ──
  showGameOver(data, onRestart, onHome) {
    const container = document.getElementById('game-over-content');
    const winnerText = data.winner === 'civilians' ? '🎉 平民陣營獲勝！' : '🕵️ 間諜陣營獲勝！';
    let html = `<h2 class="winner-text ${data.winner}">${winnerText}</h2>`;
    html += `<div class="word-reveal-final">`;
    html += `<p>平民詞：<strong>${data.civilianWord}</strong></p>`;
    html += `<p>間諜詞：<strong>${data.spyWord}</strong></p>`;
    html += `<p class="category-tag">${data.category}</p>`;
    html += '</div>';
    html += '<div class="all-players-reveal">';
    data.players.forEach(p => {
      const emoji = p.role === 'spy' ? '🕵️' : '👤';
      const statusClass = p.isAlive ? 'alive' : 'dead';
      html += `<div class="reveal-card ${p.role} ${statusClass}">`;
      html += `<span class="reveal-emoji">${emoji}</span>`;
      html += `<span class="reveal-name">${p.nickname}</span>`;
      html += `<span class="reveal-word">${p.word}</span>`;
      html += `</div>`;
    });
    html += '</div>';
    container.innerHTML = html;
    document.getElementById('btn-play-again').onclick = onRestart;
    document.getElementById('btn-back-home').onclick = onHome;
    this.showScreen('game-over');
  }

  // ── 聊天面板 ──
  toggleChat() {
    this.chatOpen = !this.chatOpen;
    document.getElementById('chat-panel').classList.toggle('open', this.chatOpen);
    if (this.chatOpen) {
      const msgList = document.getElementById('chat-messages');
      msgList.scrollTop = msgList.scrollHeight;
    }
  }

  addChatMessage(msg) {
    this._chatMessages.push(msg);
    const msgList = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = msg.isSystem ? 'chat-msg system' : 'chat-msg';
    const time = new Date(msg.timestamp).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
    div.innerHTML = msg.isSystem
      ? `<span class="chat-system">${msg.text}</span>`
      : `<span class="chat-time">${time}</span><span class="chat-name">${msg.from}</span><span class="chat-text">${this._escapeHtml(msg.text)}</span>`;
    msgList.appendChild(div);
    msgList.scrollTop = msgList.scrollHeight;
    // 如果聊天未開啟，顯示未讀標記
    if (!this.chatOpen) {
      document.getElementById('chat-badge').classList.add('show');
    }
  }

  // ── 設定面板 ──
  toggleSettings() {
    this.settingsOpen = !this.settingsOpen;
    document.getElementById('settings-panel').classList.toggle('open', this.settingsOpen);
  }

  // ── 說話指示燈 ──
  updateSpeakingIndicator(nickname, isSpeaking) {
    const cards = document.querySelectorAll('.player-card, .vote-card');
    cards.forEach(card => {
      if (card.textContent.includes(nickname)) {
        card.classList.toggle('speaking', isSpeaking);
      }
    });
  }

  // ── Toast 通知 ──
  showToast(msg, duration = 2500) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // ── 載入狀態 ──
  showLoading(msg) {
    document.getElementById('loading-text').textContent = msg;
    document.getElementById('loading-overlay').classList.add('show');
  }

  hideLoading() {
    document.getElementById('loading-overlay').classList.remove('show');
  }

  _escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}
