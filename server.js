const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');
require('dotenv').config();

const app = express();
app.use(express.json());

// PostgreSQL 연결
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// DB 초기화
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id TEXT PRIMARY KEY,
      day INTEGER DEFAULT 1,
      question_index INTEGER DEFAULT 0,
      followup_count INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT FALSE,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      day INTEGER NOT NULL,
      topic TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('DB 초기화 완료');
}

// 7일 인터뷰 플랜
const DAY_PLAN = {
  1: { theme: '어린 시절', topics: ['태어난 곳과 고향 풍경', '가족과 형제들', '어린 시절 가장 소중한 추억', '동네 친구들과 놀이', '초등학교 시절'] },
  2: { theme: '학창 시절', topics: ['중고등학교 생활', '기억에 남는 선생님', '그 시절 꿈과 목표', '공부와 취미 활동', '졸업 후 첫 발걸음'] },
  3: { theme: '첫 사랑과 결혼', topics: ['첫사랑의 기억', '배우자와의 만남', '결혼식과 신혼 시절', '자녀가 태어났을 때', '가정을 꾸리며 느낀 것'] },
  4: { theme: '인생', topics: ['첫 직장과 일', '가장 힘들었던 시절', '가장 자랑스러운 순간', '인생의 전환점', '포기하지 않고 버텼던 것'] },
  5: { theme: '삶의 철학', topics: ['내 인생의 신조', '가장 소중하게 여기는 것', '후회되는 것', '잘했다고 생각하는 것', '인생에서 배운 가장 큰 교훈'] },
  6: { theme: '노년과 가족', topics: ['지금의 일상', '자녀와 손주 이야기', '나이 들면서 달라진 것', '지금 가장 행복한 것', '가족에게 하고 싶은 말'] },
  7: { theme: '회고', topics: ['내 인생을 한마디로 표현한다면', '가장 빛났던 순간', '다시 태어난다면', '세상에 남기고 싶은 것', '사랑하는 사람들에게 전하는 말'] }
};

const MAX_FOLLOWUPS = 2;
const MAX_QUESTIONS = 5;

// 유저 상태 조회
async function getUserState(userId) {
  const result = await pool.query('SELECT * FROM user_state WHERE user_id = $1', [userId]);
  if (result.rows.length === 0) return null;
  return result.rows[0];
}

// 유저 상태 저장/업데이트
async function upsertUserState(userId, state) {
  await pool.query(`
    INSERT INTO user_state (user_id, day, question_index, followup_count, completed)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id) DO UPDATE SET
      day = $2, question_index = $3, followup_count = $4,
      completed = $5, updated_at = CURRENT_TIMESTAMP
  `, [userId, state.day, state.question_index, state.followup_count, state.completed]);
}

// 대화 저장
async function saveMessage(userId, day, topic, role, content) {
  await pool.query(
    'INSERT INTO conversations (user_id, day, topic, role, content) VALUES ($1, $2, $3, $4, $5)',
    [userId, day, topic, role, content]
  );
}

// 현재 주제 대화 기록 조회
async function getTopicHistory(userId, day, topic) {
  const result = await pool.query(
    'SELECT role, content FROM conversations WHERE user_id = $1 AND day = $2 AND topic = $3 ORDER BY created_at',
    [userId, day, topic]
  );
  return result.rows;
}

// 전체 대화 기록 조회
async function getAllHistory(userId) {
  const result = await pool.query(
    'SELECT day, topic, role, content FROM conversations WHERE user_id = $1 ORDER BY created_at',
    [userId]
  );
  return result.rows;
}

// Claude API 호출
async function callClaude(systemPrompt, messages) {
  const response = await axios.post('https://api.anthropic.com/v1/messages', {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: systemPrompt,
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

// 질문 생성
async function generateQuestion(state, userMessage, history) {
  const dayInfo = DAY_PLAN[state.day];
  const currentTopic = dayInfo.topics[state.question_index];
  const isFollowUp = state.followup_count < MAX_FOLLOWUPS;

  const messages = [
    ...history.map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: userMessage }
  ];

  if (isFollowUp) {
    return await callClaude(
      `당신은 어르신의 인생 이야기를 따뜻하게 기록하는 인터뷰어입니다.
현재 주제: [${dayInfo.theme}] - ${currentTopic}

어르신의 답변에 진심으로 공감하고, 이 주제를 더 깊이 이야기할 수 있는 꼬리질문 1개를 해주세요.

형식:
[공감 한 문장]

[꼬리질문]

주의: 짧고 따뜻하게, 구체적인 기억이나 감정을 떠올릴 수 있는 질문, 존댓말`,
      messages
    );
  } else {
    // 다음 대질문으로 넘어감 (상태는 호출 전에 이미 업데이트)
    const nextTopic = dayInfo.topics[state.question_index];
    return await callClaude(
      `당신은 어르신의 인생 이야기를 따뜻하게 기록하는 인터뷰어입니다.
현재 주제: [${dayInfo.theme}] - ${nextTopic}

이 주제에 대해 처음 여쭤보는 대질문 1개를 만들어주세요.

형식:
"이번엔 [주제]에 대해 여쭤볼게요." 같은 자연스러운 전환 한 문장

[대질문]

주의: 열린 질문으로, 어르신이 자유롭게 이야기하실 수 있도록, 존댓말`,
      [{ role: 'user', content: `${nextTopic}에 대해 질문해주세요.` }]
    );
  }
}

// 인생책 생성
async function generateBook(userId) {
  const history = await getAllHistory(userId);
  const grouped = {};
  history.forEach(h => {
    const key = `${h.day}일차`;
    if (!grouped[key]) grouped[key] = [];
    if (h.role === 'user') grouped[key].push(h.content);
  });

  const summary = Object.entries(grouped)
    .map(([day, answers]) => `[${day}]\n${answers.join('\n')}`)
    .join('\n\n');

  return await callClaude(
    `당신은 어르신의 인생 이야기를 아름다운 책으로 정리하는 작가입니다.
7일 동안 나눈 대화를 바탕으로 따뜻하고 감동적인 인생책 서문을 써주세요.
500자 내외로 어르신의 삶을 존중하고 아름답게 표현해주세요.`,
    [{ role: 'user', content: summary }]
  );
}

// 카카오 응답 포맷
function kakaoResponse(text) {
  return { version: '2.0', template: { outputs: [{ simpleText: { text } }] } };
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: '인생책 챗봇 서버 실행 중' });
});

app.post('/webhook', async (req, res) => {
  try {
    const userId = req.body.userRequest?.user?.id || 'unknown';
    const utterance = (req.body.userRequest?.utterance || '').trim();

    if (!utterance) return res.json(kakaoResponse('말씀을 듣지 못했어요. 다시 한번 말씀해 주실 수 있을까요?'));

    // 시작하기
    if (utterance === '시작하기') {
      let state = await getUserState(userId);
      if (!state) {
        state = { day: 1, question_index: 0, followup_count: 0, completed: false };
        await upsertUserState(userId, state);
      }
      const dayInfo = DAY_PLAN[state.day];
      const topic = dayInfo.topics[state.question_index];
      const firstQuestion = await callClaude(
        `당신은 어르신의 인생 이야기를 따뜻하게 기록하는 인터뷰어입니다.
오늘은 [${dayInfo.theme}]에 대해 이야기 나눌 거예요.
첫 번째 주제인 "${topic}"에 대한 대질문 1개를 만들어주세요.
따뜻하고 편안한 인사와 함께, 열린 질문으로 시작해주세요. 존댓말 사용.`,
        [{ role: 'user', content: '첫 질문을 시작해주세요.' }]
      );
      await saveMessage(userId, state.day, topic, 'assistant', firstQuestion);
      return res.json(kakaoResponse(firstQuestion));
    }

    // 유저 상태 확인
    let state = await getUserState(userId);
    if (!state) return res.json(kakaoResponse('시작하기 버튼을 눌러주세요 😊'));

    if (state.completed) {
      const book = await generateBook(userId);
      return res.json(kakaoResponse(`📖 인생책이 완성되었습니다!\n\n${book}`));
    }

    const dayInfo = DAY_PLAN[state.day];
    const currentTopic = dayInfo.topics[state.question_index];

    // 유저 답변 저장
    await saveMessage(userId, state.day, currentTopic, 'user', utterance);

    // 히스토리 조회
    const history = await getTopicHistory(userId, state.day, currentTopic);

    // 상태 업데이트
    let newState = { ...state };
    let response;

    if (state.followup_count < MAX_FOLLOWUPS) {
      // 꼬리질문 생성
      newState.followup_count += 1;
      response = await generateQuestion(state, utterance, history);
    } else {
      // 다음 대질문으로 이동
      newState.followup_count = 0;
      newState.question_index += 1;

      if (newState.question_index >= MAX_QUESTIONS) {
        // 다음 날로 이동
        newState.question_index = 0;
        newState.day += 1;

        if (newState.day > 7) {
          newState.completed = true;
          await upsertUserState(userId, newState);
          const book = await generateBook(userId);
          return res.json(kakaoResponse(`7일간의 이야기가 모두 담겼어요 🎉\n\n📖 인생책 서문\n\n${book}`));
        }

        const nextDayInfo = DAY_PLAN[newState.day];
        response = `오늘 이야기 정말 소중했어요 😊\n내일은 [${nextDayInfo.theme}]에 대해 이야기 나눠봐요.\n\n내일 또 만나요 🌙`;
        await upsertUserState(userId, newState);
        await saveMessage(userId, state.day, currentTopic, 'assistant', response);
        return res.json(kakaoResponse(response));
      }

      // 다음 대질문 생성
      const nextTopic = DAY_PLAN[newState.day].topics[newState.question_index];
      response = await generateQuestion(newState, utterance, []);
      await saveMessage(userId, newState.day, nextTopic, 'assistant', response);
      await upsertUserState(userId, newState);
      return res.json(kakaoResponse(response));
    }

    await saveMessage(userId, newState.day, currentTopic, 'assistant', response);
    await upsertUserState(userId, newState);
    res.json(kakaoResponse(response));

  } catch (error) {
    console.error('오류 발생:', JSON.stringify(error.response?.data || error.message));
    res.json(kakaoResponse('죄송합니다, 잠시 후 다시 말씀해 주세요.'));
  }
});

const PORT = process.env.PORT || 3000;
initDB().then(() => {
  app.listen(PORT, () => console.log(`인생책 챗봇 서버 실행 중 (포트 ${PORT})`));
});
