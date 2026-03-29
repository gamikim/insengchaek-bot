const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(express.json());

// DB 초기화
const db = new Database('conversations.db');
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

// 대화 저장
function saveMessage(userId, role, content) {
  const stmt = db.prepare('INSERT INTO messages (user_id, role, content) VALUES (?, ?, ?)');
  stmt.run(userId, role, content);
}

// 대화 불러오기 (최근 10개)
function getHistory(userId) {
  const stmt = db.prepare('SELECT role, content FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT 10');
  const rows = stmt.all(userId).reverse();
  return rows;
}

// 음성 → 텍스트 변환 (OpenAI Whisper)
async function speechToText(audioUrl) {
  const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
  const formData = new FormData();
  formData.append('file', Buffer.from(response.data), {
    filename: 'audio.mp3',
    contentType: 'audio/mpeg'
  });
  formData.append('model', 'whisper-1');
  formData.append('language', 'ko');

  const result = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: {
      ...formData.getHeaders(),
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    }
  });
  return result.data.text;
}

// Claude로 후속 질문 생성
async function generateFollowUp(userId, userMessage) {
  const history = getHistory(userId);

  const messages = [
    ...history.map(m => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: m.content
    })),
    {
      role: 'user',
      content: userMessage
    }
  ];

  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: `당신은 어르신의 인생 이야기를 기록하는 따뜻한 인터뷰어입니다.
어르신이 편안하게 이야기를 이어갈 수 있도록 짧고 친근한 후속 질문 2개를 만들어주세요.

규칙:
- 존댓말 사용
- 질문은 짧고 쉽게
- 감정과 기억을 자연스럽게 끌어내는 질문
- 번호를 붙여서 2개만 출력`,
    messages
  }, {
    headers: {
      'x-api-key': process.env.CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    }
  });

  return response.data.content[0].text;
}

// 카카오 응답 형식
function kakaoResponse(text) {
  return {
    version: '2.0',
    template: {
      outputs: [{ simpleText: { text } }]
    }
  };
}

// webhook 엔드포인트
app.post('/webhook', async (req, res) => {
  try {
    const userId = req.body.userRequest?.user?.id || 'unknown';
    const utterance = req.body.userRequest?.utterance || '';
    const audioUrl = req.body.userRequest?.params?.media?.url;

    let userMessage = utterance;

    // 음성 메시지인 경우 텍스트로 변환
    if (audioUrl) {
      userMessage = await speechToText(audioUrl);
    }

    // 대화 저장
    saveMessage(userId, 'user', userMessage);

    // 후속 질문 생성
    const followUp = await generateFollowUp(userId, userMessage);

    // 응답 저장
    saveMessage(userId, 'assistant', followUp);

    const responseText = `말씀 감사합니다 😊\n조금 더 여쭤볼게요.\n\n${followUp}`;
    res.json(kakaoResponse(responseText));

  } catch (error) {
    console.error('오류:', error.message);
    res.json(kakaoResponse('죄송합니다, 잠시 후 다시 말씀해 주세요.'));
  }
});

// 서버 시작
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`서버 실행 중: 포트 ${PORT}`);
});
