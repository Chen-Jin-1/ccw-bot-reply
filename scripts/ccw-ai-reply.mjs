import md5 from './md5.mjs';

const SECRET_KEY = process.env.CCW_SECRET_KEY;
const PROJECT_ID = process.env.CCW_PROJECT_ID;
const COOKIE = process.env.CCW_COOKIE;

const AI_HUB_KEY = '3R5A^5WrN7yszj1v)1x>QztT7FD5_20H';
const AI_BASE = 'https://gandi-main.ccw.site';
const COMMUNITY_BASE = 'https://community-web.ccw.site';

async function abFetch(url, bodyObj) {
  const body = JSON.stringify(bodyObj);
  const timestamp = Date.now();
  const signature = md5('ccw' + body + timestamp, SECRET_KEY);
  const res = await fetch(url, {
    method: 'post',
    body,
    headers: {
      a: signature,
      b: String(timestamp),
      'content-type': 'application/json',
      cookie: COOKIE,
    },
  });
  const json = await res.json();
  if (json.status !== 200) {
    throw new Error(`abFetch error: code=${json.code}, msg=${json.msg}, url=${url}`);
  }
  return json.body;
}

async function aiChat(text) {
  const aiBody = {
    projectId: PROJECT_ID,
    gameWorld: { bg: '' },
    assistantRole: { name: 'AI助手' },
    userRole: {},
    histories: [],
    text,
    extra: { lang: 'Chinese' },
  };
  const payload = JSON.stringify(aiBody);
  const ts = Date.now().toString();
  const key = md5(`${payload}\n${ts}`, AI_HUB_KEY);
  const res = await fetch(
    `${AI_BASE}/ai/hub/chat-with-game-assistant?key=${key}&ts=${ts}`,
    {
      method: 'post',
      headers: { 'content-type': 'application/json' },
      body: payload,
    }
  );
  const json = await res.json();
  if (json.status !== 200) {
    throw new Error(`aiChat error: code=${json.code}, msg=${json.msg}`);
  }
  return json.body.text;
}

async function main() {
  // 1. 未读数
  const stats = await abFetch(
    `${COMMUNITY_BASE}/notification/stats/v2`,
    { countAll: true }
  );
  const n = stats.COMMENT_TO_ME || 0;
  console.log(`[stats] COMMENT_TO_ME = ${n}`);
  if (n <= 0) return;

  // 2. 拉第一页（此时 stats 会清零）
  const pageBody = await abFetch(
    `${COMMUNITY_BASE}/notification/page?page=1&sortType=DESC`,
    { notifyGroup: 'COMMENT_TO_ME', page: 1 }
  );
  const list = pageBody.data || [];
  console.log(`[page] 拉到 ${list.length} 条，将处理前 ${Math.min(n, list.length)} 条`);

  // DESC 新到旧；按 n 截取。若 n > 20（perPage），只处理第一页
  const targets = list.slice(0, n);
  if (targets.length < n) {
    console.log(`[warn] 未读数 ${n} 大于第一页 ${list.length} 条，剩余留待下次`);
  }

  // 3. 逐条处理
  for (const item of targets) {
    const commentText = item.comment || item.message || '';
    const commentId = item.triggeredById;
    const senderName = item.senderName;
    if (!commentId) {
      console.log(`[skip] 缺 triggeredById:`, item);
      continue;
    }
    console.log(`[comment] id=${commentId} sender=${senderName} text=${commentText}`);

    let reply;
    try {
      reply = await aiChat(commentText);
    } catch (e) {
      console.error(`[ai error] id=${commentId}`, e.message);
      continue; // 单条失败不影响其他条
    }
    if (!reply) {
      console.log(`[skip] AI 回复为空 id=${commentId}`);
      continue;
    }
    console.log(`[ai reply] id=${commentId} -> ${reply}`);

    try {
      const replyBody = await abFetch(`${COMMUNITY_BASE}/comment/reply`, {
        content: reply,
        replyToId: commentId,
      });
      console.log(`[reply ok] id=${commentId}`, replyBody);
    } catch (e) {
      console.error(`[reply error] id=${commentId}`, e.message);
    }

    // 条间隔，降低风控风险
    await new Promise((r) => setTimeout(r, 1500));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});