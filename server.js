const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
require('dotenv').config();

const app = express();
app.use(express.json());

const conversations = new Map();

const WELCOME_MESSAGE = `안녕하세요 😊

어르신의 소중한 삶을 책으로 남겨드리는
인생책 챗봇입니다.

살아오신 이야기들, 기억 속 풍경들,
그리고 마음 깊이 간직해온 순간들을
저와 함께 천천히 풀어보시겠어요?`;

function getHistory(userId) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  return conversations.get(userId).slice(-10);
}

function saveMessage(userId, role, content) {
  if (!conversations.has(userId)) conversations.set(userId, []);
  const history = conversations.get(userId);
  history.push({ role, content });
  if (history.length > 30) conversations.set(userId, history.slice(-30));
}

function isNewUser(userId) {
  return !conversations.has(userId) || conversations.get(userId).length === 0;
}

async function speechToText(audioUrl) {
  const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
  const formData = new FormData();
  formData.append('file', Buffer.from(response.data), { filename: 'audio.mp3', contentType: 'audio/mpeg' });
  formData.append('model', 'whisper-1');
  formData.append('language', 'ko');
  const result = await axios.post('https://api.openai.com/v1/audio/transcriptions', formData, {
    headers: { ...formData.getHeaders(), 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
  });
  return result.data.text;
}

async function generateFollowUp(userId, userMessage) {
  const messages = [...getHistory(userId), { role: 'user', content: userMessage }];
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: `당신은 어르신의 인생 이야기를 따뜻하게 기록해드리는 인터뷰어입니다.

어르신이 말씀하신 내용에 진심으로 공감한 후, 이야기를 더 깊이 이어갈 수 있도록 후속 질문 2개를 해주세요.

응답 형식:
[공감 한 문장]

[질문 1]

[질문 2]

주의사항:
- 어르신께 편안한 존댓말 사용
- 짧고 쉬운 문장으로
- 감정, 구체적인 기억, 사람, 장소를 떠올릴 수 있는 질문
- 번호나 기호 없이 자연스럽게`,
    messages
  }, {
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' }
  });
  return response.data.content[0].text;
}

function kakaoResponse(text) {
  return { version: '2.0', template: { outputs: [{ simpleText: { text } }] } };
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '인생책 챗봇 서버 실행 중' });
});

app.post('/webhook', async (req, res) => {
  try {
    const userId = req.body.userRequest?.user?.id || 'unknown';
    const utterance = req.body.userRequest?.utterance || '';
    const audioUrl = req.body.userRequest?.params?.media?.url;
    let userMessage = utterance;

    if (audioUrl) userMessage = await speechToText(audioUrl);
    if (!userMessage.trim()) return res.json(kakaoResponse('말씀을 듣지 못했어요. 다시 한번 말씀해 주실 수 있을까요?'));

    // 시작하기 버튼 클릭 시 첫 질문 시작
    if (userMessage.trim() === '시작하기') {
      const firstQuestion = `어르신, 반갑습니다 😊\n\n첫 번째 이야기부터 여쭤볼게요.\n\n태어나신 곳은 어디세요? 어린 시절 어떤 동네에서 자라셨는지 편하게 말씀해 주세요.`;
      saveMessage(userId, 'assistant', firstQuestion);
      return res.json(kakaoResponse(firstQuestion));
    }

    const followUp = await generateFollowUp(userId, userMessage);
    saveMessage(userId, 'user', userMessage);
    saveMessage(userId, 'assistant', followUp);
    res.json(kakaoResponse(followUp));
  } catch (error) {
    console.error('오류 발생:', JSON.stringify(error.response?.data || error.message));
    res.json(kakaoResponse('죄송합니다, 잠시 후 다시 말씀해 주세요.'));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`인생책 챗봇 서버 실행 중 (포트 ${PORT})`);
});
