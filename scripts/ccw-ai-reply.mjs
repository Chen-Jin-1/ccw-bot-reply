import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const md5 = require('./md5.cjs');

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
  if (json.status !== 200) throw new Error(`abFetch error: code=${json.code}, msg=${json.msg}, url=${url}`);
  return json.body;
}

async function aiChat(item, maxRetries = 3) {
  const senderName = item.senderName || '某位用户';
  const senderOid = item.senderOid || '未知OID';
  const userMessage = item.comment || ''; 
  
  // 关键修复：如果 message 为 null，就说明是直接留言，给个默认空字符串
  const botPreviousMessage = item.message || ''; 
  
  const isoTime = new Date().toISOString();

  // 动态生成上下文描述
  let contextStr = '';
  if (botPreviousMessage) {
    // 有上下文：用户是在回复某条消息
    contextStr = `
你之前说：“${botPreviousMessage}”
用户 ${senderName} (OID: ${senderOid}) 刚刚回复说：“${userMessage}”`;
  } else {
    // 无上下文：用户是直接留言
    contextStr = `
用户 ${senderName} (OID: ${senderOid}) 在你的留言板直接留言：“${userMessage}”`;
  }

  const backgroundInfo = `
[系统时间]
当前 UTC 时间：${isoTime}。当用户问时间时，请转换为北京时间（UTC+8）回答

[对话上下文]
${contextStr}

[回复要求]
直接针对用户的最新回复解答，自然、友好
**禁止使用任何 Markdown 格式**（绝对不要使用星号 *、井号 #、反引号 \`、列表符号 - 等，除非用户要求），纯文本回复
**回复内容尽量简短，不超过 2000 字符**`;

  const aiBody = {
    projectId: PROJECT_ID,
    gameWorld: {
      bg: `你是一个活跃在 CCW（共创世界）社区的智能助手，名为 Chen-Jin BOT (OID: 6981f20886bbc77f84e4825f)
作者为 Chen-Jin (OID: 692538ef86bbc77f84e3b259)
【关于你的起源与原理】
由作者 Chen-Jin 用 Node.js 编写，GitHub Actions 运行，Cloudflare Worker Cron 定时器每十分钟触发一次 Workflow
GitHub 项目链接：https://github.com/Chen-Jin-1/ccw-bot-reply
GitHub Workflow 链接：https://github.com/Chen-Jin-1/ccw-bot-reply/actions/workflows/ccw-ai-reply.yml
【你的性格】
你聪明、热情、懂很多梗，偶尔还会开个小玩笑`
    },
    assistantRole: { 
      name: 'Chen-Jin BOT', 
      bg: backgroundInfo, 
    },
    userRole: { 
      name: senderName,
      bg: `OID: ${senderOid}`
    },
    histories: [], 
    text: userMessage, 
    extra: { lang: 'Chinese' },
  };

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
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
      
      if (json.status !== 200) throw new Error(`code=${json.code}, msg=${json.msg}`);

      const text = json.body?.text;
      if (text) return text; 
      else throw new Error('返回内容为空');
    } catch (e) {
      console.log(`[ai warn] 第 ${attempt} 次请求失败: ${e.message}`);
      if (attempt === maxRetries) throw new Error(`AI 连续 ${maxRetries} 次请求失败: ${e.message}`);
      // 等待 2 秒后重试
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function main() {
  // 1. 拉取第一页未读通知（使用 v3 新接口）
  const pageBody = await abFetch(
    `${COMMUNITY_BASE}/notification/v3/page`,
    { group: 'REPLY', pageSize: 20 }
  );
  
  // 注意：新版接口列表字段叫 items，并且带了 readToken
  const list = pageBody.items || [];
  const readToken = pageBody.readToken;
  console.log(`[page] 拉到 ${list.length} 条记录`);

  if (list.length === 0) return;

  const unreadIdsToMark = [];
  let processedCount = 0;

  // 2. 逐条处理（从新到旧）
  for (const item of list) {
    // 遇到已读，直接停止遍历（因为 DESC 排序，后面的肯定也是已读）
    if (item.readState === 'READ') {
      console.log(`[stop] 遇到已读消息，结束遍历`);
      break;
    }

    // 把未读的 ID 收集起来准备标已读
    unreadIdsToMark.push(item.id);

    const commentText = item.comment || '';
    // 注意：在新版里，被回复的原评论 ID 可能是 triggeredById 或 target.commentId
    const commentId = item.triggeredById || item.target?.commentId; 
    const senderName = item.senderName;
    
    if (!commentId) {
      console.log(`[skip] 缺少评论 ID`);
      continue;
    }

    console.log(`[comment] id=${commentId} sender=${senderName}`);

    let reply;
    try {
      reply = await aiChat(item);
    } catch (e) {
      console.error(`[ai error] id=${commentId}`, e.message);
      continue;
    }
    if (!reply) continue;

    try {
      const replyBody = await abFetch(`${COMMUNITY_BASE}/comment/reply`, {
        content: reply,
        replyToId: commentId,
      });
      const newCommentId = replyBody?.id || '未知';
      console.log(`[reply ok] 回复评论 ID=${commentId} -> 新评论 ID=${newCommentId}`);
      
      processedCount++;
      
      // 处理完一条，间隔一下
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[reply error] 回复评论 ID=${commentId} 失败:`, e.message);
    }
  }

  // 3. 批量标记已读（保护机制：如果真处理了或者收集到了未读，才去请求接口）
  if (unreadIdsToMark.length > 0) {
    console.log(`[mark_read] 标记 ${unreadIdsToMark.length} 条消息为已读...`);
    try {
      const markRes = await abFetch(`${COMMUNITY_BASE}/notification/v3/mark_read`, {
        group: 'REPLY',
        filter: 'ALL',
        readToken: readToken,
        ids: unreadIdsToMark
      });
      console.log(`[mark_read] 成功:`, JSON.stringify(markRes));
    } catch (e) {
      console.error(`[mark_read error] 标记已读失败:`, e.message);
    }
  }

  console.log(`完成：本次共处理 ${processedCount} 条未读消息`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});