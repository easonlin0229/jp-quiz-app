const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const os = require('os');
const DEFAULT_BANKS = require('./banks');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = '1234'; // 後台管理密碼
const DATA_FILE = path.join(__dirname, 'vocab_banks.json');
const QUESTION_TIME_MS = 12000; // 每題 12 秒搶答
const REVEAL_TIME_MS = 3800;    // 揭曉答案與讀音卡停留 3.8 秒

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// === 讀寫題庫檔案 ===
function loadBanks() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_BANKS, null, 2), 'utf-8');
    return JSON.parse(JSON.stringify(DEFAULT_BANKS));
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_BANKS));
}

function saveBanks(banks) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(banks, null, 2), 'utf-8');
}

let vocabBanks = loadBanks();

// === 智慧動態出題引擎 ===
function shuffle(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

// 擷取主要日文讀音供語音朗讀使用
function cleanSpeechText(kana, kanji) {
  const base = (kana || kanji || '').split(/[\/／(（]/)[0].trim();
  return base || kanji || '';
}

function buildQuestionFromVocab(item, allItems, requestedMode) {
  const hasDistinctKanji = item.kanji && item.kana && item.kanji !== item.kana;
  let mode = requestedMode;

  if (mode === 'mixed') {
    const pool = hasDistinctKanji ? ['jp2zh', 'zh2jp', 'kanji2kana'] : ['jp2zh', 'zh2jp'];
    mode = pool[Math.floor(Math.random() * pool.length)];
  } else if (mode === 'kanji2kana' && !hasDistinctKanji) {
    mode = 'jp2zh';
  }

  // 優先挑選「同一類別」的單字當干擾選項，提高學習鑑別度
  const sameCat = shuffle(allItems.filter(x => x !== item && x.category === item.category));
  const otherCat = shuffle(allItems.filter(x => x !== item && x.category !== item.category));
  const candidates = [...sameCat, ...otherCat];

  const getOptionLabel = (v) => {
    if (mode === 'jp2zh') return v.zh;
    if (mode === 'kanji2kana') return v.kana;
    // zh2jp：若漢字與假名不同則一併顯示方便辨認
    return v.kanji === v.kana ? v.kanji : `${v.kanji}（${v.kana}）`;
  };

  const correctLabel = getOptionLabel(item);
  const usedLabels = new Set([correctLabel]);
  const distractors = [];

  for (const cand of candidates) {
    if (distractors.length >= 3) break;
    const label = getOptionLabel(cand);
    if (!usedLabels.has(label)) {
      usedLabels.add(label);
      distractors.push(label);
    }
  }

  const options = shuffle([correctLabel, ...distractors]);
  const answer = options.indexOf(correctLabel);

  let prompt = '';
  let subPrompt = '';
  let modeLabel = '';

  if (mode === 'jp2zh') {
    modeLabel = '日翻中';
    prompt = item.kanji;
    subPrompt = item.kanji !== item.kana ? item.kana : '選出正確的中文意思';
  } else if (mode === 'zh2jp') {
    modeLabel = '中翻日';
    prompt = item.zh;
    subPrompt = '選出對應的日文單字';
  } else {
    modeLabel = '漢字讀音';
    prompt = item.kanji;
    subPrompt = `中文：${item.zh}｜選出正確假名`;
  }

  return {
    category: item.category || '綜合',
    modeLabel,
    prompt,
    subPrompt,
    jpSpeech: cleanSpeechText(item.kana, item.kanji),
    options,
    answer,
    vocab: {
      zh: item.zh,
      kanji: item.kanji,
      kana: item.kana,
      romaji: item.romaji
    }
  };
}

function generateRoundQuestions(bank, count, mode) {
  const validItems = (bank.items || []).filter(i => i.zh && (i.kanji || i.kana));
  const shuffled = shuffle(validItems);
  const limit = count === 'all' ? shuffled.length : Math.min(Number(count) || 10, shuffled.length);
  return shuffled.slice(0, limit).map(item => buildQuestionFromVocab(item, validItems, mode));
}

// === REST API：題庫讀取與後台儲存 ===
app.get('/api/banks', (req, res) => {
  res.json(vocabBanks);
});

app.post('/api/admin/verify', (req, res) => {
  if (req.body.pin === ADMIN_PIN) return res.json({ ok: true });
  return res.status(401).json({ ok: false, message: '管理密碼錯誤' });
});

app.post('/api/banks', (req, res) => {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, message: '未授權' });
  }
  if (!Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, message: '格式錯誤' });
  }
  vocabBanks = req.body;
  saveBanks(vocabBanks);
  res.json({ ok: true });
});

app.post('/api/banks/reset', (req, res) => {
  if (req.headers['x-admin-pin'] !== ADMIN_PIN) {
    return res.status(401).json({ ok: false, message: '未授權' });
  }
  vocabBanks = JSON.parse(JSON.stringify(DEFAULT_BANKS));
  saveBanks(vocabBanks);
  res.json({ ok: true, banks: vocabBanks });
});

// === 即時對戰房間核心 ===
const rooms = {};

function generatePin() {
  let pin;
  do {
    pin = String(Math.floor(100000 + Math.random() * 900000));
  } while (rooms[pin]);
  return pin;
}

function clearRoomTimers(room) {
  if (!room) return;
  if (room.timer) { clearTimeout(room.timer); room.timer = null; }
  if (room.revealTimer) { clearTimeout(room.revealTimer); room.revealTimer = null; }
  if (room.botTimers) {
    room.botTimers.forEach(t => clearTimeout(t));
    room.botTimers = [];
  }
}

function getSortedPlayers(room) {
  return Object.values(room.players)
    .map(p => ({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      score: p.score,
      streak: p.streak,
      isBot: !!p.isBot,
      answered: p.answered,
      lastAnswer: p.lastAnswer,
      lastPoints: p.lastPoints,
      isCorrect: p.isCorrect
    }))
    .sort((a, b) => b.score - a.score);
}

function sendNextQuestion(pin) {
  const room = rooms[pin];
  if (!room) return;

  if (room.currentIndex >= room.questions.length) {
    finishGame(pin);
    return;
  }

  clearRoomTimers(room);
  room.status = 'playing';
  room.questionStartTime = Date.now();

  Object.values(room.players).forEach(p => {
    p.answered = false;
    p.lastAnswer = null;
    p.lastPoints = 0;
    p.isCorrect = false;
  });

  const qObj = room.questions[room.currentIndex];

  io.to(pin).emit('question_start', {
    index: room.currentIndex,
    total: room.questions.length,
    level: room.bankLevel,
    category: qObj.category,
    modeLabel: qObj.modeLabel,
    prompt: qObj.prompt,
    subPrompt: qObj.subPrompt,
    jpSpeech: qObj.jpSpeech,
    options: qObj.options,
    timeLimit: QUESTION_TIME_MS,
    players: getSortedPlayers(room)
  });

  // 排程 AI 對手搶答
  Object.values(room.players).forEach(p => {
    if (p.isBot) {
      const delay = 1500 + Math.random() * 5200;
      const t = setTimeout(() => {
        if (!rooms[pin] || rooms[pin].status !== 'playing') return;
        const isSmart = Math.random() < 0.72;
        let pick = qObj.answer;
        if (!isSmart) {
          const wrongs = qObj.options.map((_, i) => i).filter(i => i !== qObj.answer);
          pick = wrongs[Math.floor(Math.random() * wrongs.length)];
        }
        handleAnswer(pin, p.id, pick);
      }, delay);
      room.botTimers.push(t);
    }
  });

  room.timer = setTimeout(() => revealAnswer(pin), QUESTION_TIME_MS);
}

function handleAnswer(pin, playerId, answerIndex) {
  const room = rooms[pin];
  if (!room || room.status !== 'playing') return;
  const player = room.players[playerId];
  if (!player || player.answered) return;

  const qObj = room.questions[room.currentIndex];
  const elapsed = Date.now() - room.questionStartTime;

  player.answered = true;
  player.lastAnswer = answerIndex;

  if (answerIndex === qObj.answer) {
    const speedRatio = Math.max(0, 1 - elapsed / QUESTION_TIME_MS);
    const gained = 500 + Math.round(speedRatio * 500) + player.streak * 50;
    player.isCorrect = true;
    player.streak += 1;
    player.lastPoints = gained;
    player.score += gained;
  } else {
    player.isCorrect = false;
    player.streak = 0;
    player.lastPoints = 0;
  }

  const allPlayers = Object.values(room.players);
  const answeredCount = allPlayers.filter(p => p.answered).length;

  io.to(pin).emit('player_answered', {
    answeredCount,
    totalPlayers: allPlayers.length
  });

  if (answeredCount >= allPlayers.length) {
    revealAnswer(pin);
  }
}

function revealAnswer(pin) {
  const room = rooms[pin];
  if (!room || room.status !== 'playing') return;

  clearRoomTimers(room);
  room.status = 'reveal';

  const qObj = room.questions[room.currentIndex];
  const answerCounts = [0, 0, 0, 0];
  Object.values(room.players).forEach(p => {
    if (p.lastAnswer !== null && p.lastAnswer >= 0 && p.lastAnswer < 4) {
      answerCounts[p.lastAnswer] += 1;
    }
  });

  io.to(pin).emit('question_reveal', {
    correctIndex: qObj.answer,
    vocab: qObj.vocab,
    jpSpeech: qObj.jpSpeech,
    answerCounts,
    players: getSortedPlayers(room)
  });

  room.revealTimer = setTimeout(() => {
    room.currentIndex += 1;
    sendNextQuestion(pin);
  }, REVEAL_TIME_MS);
}

function finishGame(pin) {
  const room = rooms[pin];
  if (!room) return;
  clearRoomTimers(room);
  room.status = 'finished';

  io.to(pin).emit('game_over', {
    players: getSortedPlayers(room),
    bankTitle: room.bankTitle,
    bankLevel: room.bankLevel
  });
}

// === Socket.io 連線處理 ===
io.on('connection', (socket) => {
  socket.on('create_room', ({ name, avatar, bankId, count, mode }) => {
    const bank = vocabBanks.find(b => b.id === bankId) || vocabBanks[0];
    if (!bank || !bank.items || bank.items.length < 4) {
      return socket.emit('error_msg', '題庫至少需要 4 個單字才能開局！');
    }

    const pin = generatePin();
    const roundCount = count || '10';
    const quizMode = mode || 'mixed';

    rooms[pin] = {
      pin,
      hostId: socket.id,
      bankId: bank.id,
      bankTitle: bank.title,
      bankLevel: bank.level,
      roundCount,
      quizMode,
      status: 'lobby',
      players: {
        [socket.id]: {
          id: socket.id,
          name: (name || '日語挑戰者').slice(0, 12),
          avatar: avatar || '🦊',
          score: 0,
          streak: 0,
          isBot: false,
          answered: false,
          lastAnswer: null,
          lastPoints: 0,
          isCorrect: false
        }
      },
      questions: [],
      currentIndex: 0,
      timer: null,
      revealTimer: null,
      botTimers: []
    };

    socket.join(pin);
    socket.data.pin = pin;

    const actualCount = roundCount === 'all' ? bank.items.length : Math.min(Number(roundCount), bank.items.length);
    socket.emit('room_joined', {
      pin,
      isHost: true,
      bankTitle: bank.title,
      bankLevel: bank.level,
      questionCount: actualCount,
      quizMode,
      players: getSortedPlayers(rooms[pin])
    });
  });

  socket.on('join_room', ({ pin, name, avatar }) => {
    const cleanPin = String(pin || '').trim();
    const room = rooms[cleanPin];
    if (!room) return socket.emit('error_msg', '找不到此房號，請確認是否輸入正確。');
    if (room.status !== 'lobby') return socket.emit('error_msg', '房間已經開始對戰囉！');

    room.players[socket.id] = {
      id: socket.id,
      name: (name || '神秘玩家').slice(0, 12),
      avatar: avatar || '🐱',
      score: 0,
      streak: 0,
      isBot: false,
      answered: false,
      lastAnswer: null,
      lastPoints: 0,
      isCorrect: false
    };

    socket.join(cleanPin);
    socket.data.pin = cleanPin;

    const bank = vocabBanks.find(b => b.id === room.bankId);
    const totalLen = bank ? bank.items.length : 10;
    const actualCount = room.roundCount === 'all' ? totalLen : Math.min(Number(room.roundCount), totalLen);

    socket.emit('room_joined', {
      pin: cleanPin,
      isHost: false,
      bankTitle: room.bankTitle,
      bankLevel: room.bankLevel,
      questionCount: actualCount,
      quizMode: room.quizMode,
      players: getSortedPlayers(room)
    });

    io.to(cleanPin).emit('lobby_update', {
      hostId: room.hostId,
      players: getSortedPlayers(room)
    });
  });

  socket.on('add_bot', ({ pin }) => {
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    const botNames = ['柴犬學長', '京都狐狸', '抹茶貓咪', '大阪章魚'];
    const botAvatars = ['🐕', '🦊', '🐱', '🐙'];
    const botCount = Object.values(room.players).filter(p => p.isBot).length;
    if (botCount >= 4) return socket.emit('error_msg', '最多加入 4 位 AI 對手');

    const botId = `bot_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    room.players[botId] = {
      id: botId,
      name: `${botNames[botCount % botNames.length]}(AI)`,
      avatar: botAvatars[botCount % botAvatars.length],
      score: 0,
      streak: 0,
      isBot: true,
      answered: false,
      lastAnswer: null,
      lastPoints: 0,
      isCorrect: false
    };

    io.to(pin).emit('lobby_update', {
      hostId: room.hostId,
      players: getSortedPlayers(room)
    });
  });

  socket.on('start_game', ({ pin }) => {
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id || room.status !== 'lobby') return;
    const bank = vocabBanks.find(b => b.id === room.bankId);
    if (!bank || bank.items.length < 4) return socket.emit('error_msg', '題庫單字不足 4 個');

    room.questions = generateRoundQuestions(bank, room.roundCount, room.quizMode);
    room.currentIndex = 0;
    Object.values(room.players).forEach(p => { p.score = 0; p.streak = 0; });
    sendNextQuestion(pin);
  });

  socket.on('submit_answer', ({ pin, answerIndex }) => {
    handleAnswer(pin, socket.id, answerIndex);
  });

  socket.on('play_again', ({ pin }) => {
    const room = rooms[pin];
    if (!room || room.hostId !== socket.id) return;
    clearRoomTimers(room);
    room.status = 'lobby';
    Object.values(room.players).forEach(p => {
      p.score = 0; p.streak = 0; p.answered = false; p.lastAnswer = null; p.lastPoints = 0;
    });
    io.to(pin).emit('returned_to_lobby', {
      hostId: room.hostId,
      players: getSortedPlayers(room)
    });
  });

  function removePlayerFromRoom() {
    const pin = socket.data.pin;
    if (!pin || !rooms[pin]) return;
    const room = rooms[pin];
    delete room.players[socket.id];
    socket.leave(pin);
    socket.data.pin = null;

    const humans = Object.values(room.players).filter(p => !p.isBot);
    if (humans.length === 0) {
      clearRoomTimers(room);
      delete rooms[pin];
      return;
    }
    if (room.hostId === socket.id) room.hostId = humans[0].id;
    io.to(pin).emit('lobby_update', {
      hostId: room.hostId,
      players: getSortedPlayers(room)
    });
  }

  socket.on('leave_room', removePlayerFromRoom);
  socket.on('disconnect', removePlayerFromRoom);
});

function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log('🇯🇵 日語知識王 App 伺服器啟動成功！');
  console.log(`💻 Mac 電腦開啟：http://localhost:${PORT}`);
  console.log(`📱 手機連線網址：http://${getLocalIP()}:${PORT}`);
  console.log(`🔐 題庫後台密碼：${ADMIN_PIN}`);
  console.log('==================================================');
});