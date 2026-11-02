// X（推特）：xpaiming 账号榜（免登录 HTTP）。它跟踪约 700 个账号，约 6 小时一次快照，日增长 = 当天（UTC 自然日）快照末值减首值；
// 取上一个完整 UTC 日按涨粉排序 → 无头 Chrome 带日常 Chrome 的登录态打开 x.com/<handle>，截页面自己发出的 UserByScreenName
// 和帖子时间线 GraphQL 响应 → 文案 = 推文全文（长推取 note_tweet），视频推文再转写；
// 热门回复从推文详情页的 TweetDetail 响应里取，峰值日取 xpaiming 账号页的逐日涨粉。
// 默认只排 xpaiming 中文收录账号（它的国家榜按内容语言分组）；环境变量 ZF_X_COUNTRY=global 排全部收录账号，或 us|jp|kr|es|br|ir|vn 换别的语言组。
import fs from 'node:fs';
import path from 'node:path';

export const label = 'X';

const XP = 'https://xpaiming.com';
const DAY = 86_400_000;
const GQL = /\/i\/api\/graphql\/[^/]+\/(UserByScreenName|UserOriginalsTimeline|UserTweets)\?/;
const DETAIL = /\/i\/api\/graphql\/[^/]+\/TweetDetail\?/;
const USER = /\/UserByScreenName\?/;
const TIMELINE = /\/(UserOriginalsTimeline|UserTweets)\?/;
const MAX_PAGES = 3;
const GROUP = { global: '全部', cn: '中文', us: '英文', jp: '日文', kr: '韩文', es: '西班牙文', br: '葡萄牙文', ir: '波斯文', vn: '越南文' };

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const utcISO = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');
const n = (v) => (v == null || v === '' ? null : +v);

// ---------- 榜单 ----------

// 页面数据在 Next.js 的 RSC 流里（self.__next_f.push）：找含 marker 的那一行，在里面找第一个满足 test 的对象。
// 账号榜的表格只服务端渲染前 50 行，RSC 里有全部账号和榜期 date；账号页的逐日涨粉图也在这里
function rscFind(html, marker, test) {
  const payload = [...html.matchAll(/self\.__next_f\.push\(\[1,("[^"\\]*(?:\\.[^"\\]*)*")\]\)/g)].map((m) => JSON.parse(m[1])).join('');
  const line = payload.split('\n').find((l) => l.includes(marker));
  if (!line) return null;
  let found;
  const walk = (o) => {
    if (found || !o || typeof o !== 'object') return;
    if (test(o)) found = o;
    else Object.values(o).forEach(walk);
  };
  walk(JSON.parse(line.slice(line.indexOf(':') + 1)));
  return found;
}

export async function board(ctx) {
  const country = process.env.ZF_X_COUNTRY?.trim().toLowerCase() || 'cn';
  const scope = country === 'global' ? null : country;
  // range=yesterday 是已结束的上一个 UTC 日（当天的还在滚动）；页面按曝光排序，涨粉排序下面自己做
  const url = `${XP}/accounts?range=yesterday${scope ? `&country=${scope}` : ''}`;
  const d = rscFind(await ctx.http.text(url), '"rows":[{"account_id"', (o) => Array.isArray(o.rows) && o.date);
  if (!d?.rows?.length) throw new Error('xpaiming 页面里没找到账号数据，页面结构可能变了');
  if (d.range !== 'yesterday' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || d.stale === true) throw new Error(`xpaiming 返回的不是已结束的一天（range=${d.range} date=${d.date}）`);
  if (scope && d.countryFilter !== scope) throw new Error(`xpaiming 没有 ${scope} 榜（返回了 ${d.countryFilter}）`);
  ctx.log(`xpaiming ${GROUP[country] ?? country}收录账号 ${d.rows.length} 个`);
  const entries = d.rows
    .filter((r) => r.alive_status === 'alive' && r.follower_delta > 0)
    .sort((a, b) => b.follower_delta - a.follower_delta)
    .slice(0, ctx.opts.top)
    .map((r, i) => ({ rank: i + 1, name: r.display_name || r.handle, gain: r.follower_delta, followers: r.followers ?? null, ref: { handle: r.handle } }));
  if (!entries.length) throw new Error(`xpaiming ${d.date} 期没有涨粉的账号（快照可能没更新）`);
  return { date: d.date, tz: 'UTC', period: `日榜（xpaiming ${GROUP[country] ?? country}收录账号）`, url, entries };
}

// xpaiming 账号页「每日粉丝涨跌」近 30 天（UTC 自然日）里，窗口内涨粉最多的一天
async function peakDay(ctx, handle, board) {
  const html = await ctx.http.text(`${XP}/accounts/${encodeURIComponent(handle)}`);
  const chart = rscFind(html, '每日粉丝涨跌', (o) => o.title === '每日粉丝涨跌' && Array.isArray(o.points));
  if (!chart) throw new Error('账号页没有逐日涨粉图');
  const from = new Date(Date.parse(`${board.date}T00:00:00Z`) - ctx.opts.window * DAY).toISOString().slice(0, 10);
  let peak = null;
  for (const { date, value } of chart.points) {
    if (date >= from && date <= board.date && value > 0 && !(peak?.gain >= value)) peak = { date, gain: value };
  }
  return peak;
}

// ---------- 作品 ----------

let blocked = null; // 碰到限流后本轮不再访问 X
let lastSeen = 0; // 上一个主页读完的时刻，下一个距它留 2–4 秒

// 时间线里的推文：普通条目在 content.itemContent，自己串推的对话模块在 content.items[].item.itemContent，置顶在 TimelinePinEntry
function tweetsOf(body) {
  const tl = body?.data?.user?.result?.timeline?.timeline ?? body?.data?.user?.result?.timeline_v2?.timeline;
  const out = [];
  for (const ins of tl?.instructions ?? []) {
    for (const e of ins.entries ?? (ins.entry ? [ins.entry] : [])) {
      for (const it of e.content?.items?.map((i) => i.item) ?? [e.content]) {
        const r = it?.itemContent?.tweet_results?.result;
        const t = r?.tweet ?? r; // TweetWithVisibilityResults 多包一层
        if (t?.legacy) out.push({ t, pinned: ins.type === 'TimelinePinEntry' });
      }
    }
  }
  return out;
}

function rateLimited(res) {
  return res.status === 429 || res.body?.errors?.some?.((e) => e.code === 88);
}

// t.co 短链还原，媒体占位短链去掉；legacy 文本里 & < > 是转义过的
function tidy(s = '', urls = [], media = []) {
  for (const u of urls) if (u.url && u.expanded_url) s = s.replaceAll(u.url, u.expanded_url);
  for (const m of media) if (m.url) s = s.replaceAll(m.url, '');
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

function toWork(t, handle) {
  const l = t.legacy;
  const note = t.note_tweet?.note_tweet_results?.result;
  const art = t.article?.article_results?.result; // X 长文章：时间线里只有标题和开头一段
  const own = tidy(note?.text ?? l.full_text, note?.entity_set?.urls ?? l.entities?.urls, l.entities?.media);
  const text = art ? [art.title, art.preview_text && `${art.preview_text}…（文章节选）`, own].filter(Boolean).join('\n\n') : own;
  const video = (l.extended_entities?.media ?? []).find((m) => m.type === 'video');
  // 转写只要声音：取码率最低的 mp4（都带音轨）；GIF 没有声音，算图文
  const mp4 = (video?.video_info?.variants ?? []).filter((v) => v.content_type === 'video/mp4').sort((a, b) => (a.bitrate ?? 0) - (b.bitrate ?? 0))[0];
  return {
    id: t.rest_id,
    url: `https://x.com/${handle}/status/${t.rest_id}`,
    title: text.split('\n')[0].slice(0, 60),
    type: video ? 'video' : 'note',
    published_at: utcISO(Date.parse(l.created_at)),
    metrics: { plays: n(t.views?.count), likes: n(l.favorite_count), comments: n(l.reply_count), collects: n(l.bookmark_count), shares: n(l.retweet_count) },
    desc: text,
    media: mp4 ? { url: mp4.url, duration: (video.video_info.duration_millis ?? 0) / 1000 || null, lang: l.lang } : null,
  };
}

const cacheFile = (ctx) => path.join(ctx.opts.out, 'cache', 'x_user.json');
function remember(ctx, handle, id, name) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile(ctx), 'utf8')); } catch {}
  const old = cache[handle.toLowerCase()];
  cache[handle.toLowerCase()] = { id, name };
  fs.mkdirSync(path.dirname(cacheFile(ctx)), { recursive: true });
  fs.writeFileSync(cacheFile(ctx), JSON.stringify(cache, null, 1));
  return old && old.id !== id ? `@${handle} 换了账号（以前 id=${old.id}，现在 id=${id}）` : '';
}

export async function works(ctx, entry, board) {
  if (blocked) throw new Error(`X 本轮已停止访问（${blocked}）`);
  const { handle } = entry.ref;
  const session = await ctx.browser();
  if (!(await session.cookieHeader('x.com')).includes('auth_token=')) throw new Error('X 看别人的时间线要登录，日常 Chrome 里 x.com 没登录（登录后重跑）');

  await sleep(lastSeen + 2000 + Math.random() * 2000 - Date.now());
  const end = Date.parse(`${board.date}T23:59:59.999Z`);
  const start = Date.parse(`${board.date}T00:00:00Z`) - ctx.opts.window * DAY;
  const page = await session.open(`https://x.com/${handle}`, { capture: [GQL], waitMs: 0 });
  const list = [];
  let user;
  let used = 0;
  try {
    const limited = () => page.responses.find(rateLimited);
    const stop = () => { blocked = 'X 接口返回限流'; ctx.log(`${blocked}，停止本轮后续访问`); return new Error(`${blocked}，稍后再跑`); };

    const ures = await page.waitFor(() => page.responses.find((r) => USER.test(r.url)), 20_000).catch(() => null);
    if (limited()) throw stop();
    if (!ures) throw new Error(`@${handle} 主页 20 秒没返回账号信息（X 打不开或风控）`);
    user = ures.body?.data?.user?.result;
    if (!user) throw new Error(`@${handle} 不存在或已改名`);
    if (user.__typename !== 'User') throw new Error(`@${handle} 账号不可用（${user.reason ?? user.__typename}）`);
    const sn = user.core?.screen_name ?? user.legacy?.screen_name;
    if (sn?.toLowerCase() !== handle.toLowerCase()) throw new Error(`主页返回的账号是 @${sn}，不是榜单上的 @${handle}`);
    if (user.privacy?.protected ?? user.legacy?.protected) throw new Error(`@${handle} 是受保护账号，看不到帖子`);

    // 首屏的帖子是一页 20 条。发得勤的号第一页可能全在榜期之后，往下滚接着等页面自己加载，碰到榜期就停。
    // 后台标签页是 hidden 状态，X 不会加载下一页：先把它切到无头浏览器的前台（无头没有窗口，不影响用户）
    const pages = () => page.responses.filter((r) => TIMELINE.test(r.url));
    for (let i = 0; i < MAX_PAGES; i++) {
      if (i === 1) await page.send('Page.bringToFront');
      const res = await page.waitFor(async () => {
        if (pages()[i]) return pages()[i];
        if (i) await page.eval('window.scrollBy(0, 3000)').catch(() => {});
        return null;
      }, i ? 10_000 : 20_000).catch(() => null);
      if (limited()) throw stop();
      if (!res) {
        if (!i) throw new Error(`@${handle} 主页 20 秒没返回帖子列表（日常 Chrome 里 X 的登录可能失效了）`);
        break;
      }
      const got = tweetsOf(res.body);
      if (!got.length) break;
      list.push(...got);
      used++;
      if (Math.min(...list.filter((x) => !x.pinned).map((x) => Date.parse(x.t.legacy.created_at))) <= end) break;
    }
  } finally {
    lastSeen = Date.now();
    await page.close();
  }

  // 只算自己发的原创和引用：不要转推，串推的后续几条和回复不单算
  const seen = new Set();
  const own = list.map((x) => x.t).filter((t) => {
    if (seen.has(t.rest_id) || t.legacy.user_id_str !== user.rest_id || t.legacy.retweeted_status_result || t.legacy.in_reply_to_status_id_str) return false;
    seen.add(t.rest_id);
    return true;
  });
  const inWindow = own.filter((t) => { const ms = Date.parse(t.legacy.created_at); return ms >= start && ms <= end; });
  const earliest = Math.min(...list.filter((x) => !x.pinned).map((x) => Date.parse(x.t.legacy.created_at)));
  ctx.log(`@${handle}：主页取了 ${used} 页 ${own.length} 条原创，窗口内 ${inWindow.length} 条`);

  const peak = await peakDay(ctx, handle, board).catch((e) => { ctx.log(`@${handle} 逐日涨粉取不到（${e.message}）`); return null; });
  const notes = [remember(ctx, handle, user.rest_id, user.core?.name ?? entry.name)];
  if (!used) notes.push('主页没有帖子');
  else if (earliest > end) notes.push(`主页翻了 ${used} 页还没到榜期（最早一条 ${utcISO(earliest).slice(0, 16)}），窗口内作品没取到`);
  else if (earliest > start) notes.push(`主页只取了 ${used} 页，窗口内至少 ${inWindow.length} 条`);
  return {
    creator: { id: user.rest_id, name: user.core?.name ?? user.legacy?.name ?? entry.name, url: `https://x.com/${handle}`, followers: user.relationship_counts?.followers ?? user.legacy?.followers_count ?? entry.followers },
    works: inWindow.map((t) => toWork(t, handle)),
    note: notes.filter(Boolean).join('；'),
    ...(peak ? { peak } : {}),
  };
}

// 推文详情页按「相关度」给出的第一屏回复（约 15 条），去掉作者自己的，按点赞取前 10
async function hotReplies(ctx, work) {
  if (blocked) throw new Error(blocked);
  await sleep(lastSeen + 2000 + Math.random() * 2000 - Date.now());
  const page = await (await ctx.browser()).open(work.url, { capture: [DETAIL], waitMs: 0 });
  let res;
  try {
    res = await page.waitFor(() => page.responses[0], 20_000).catch(() => null);
  } finally {
    lastSeen = Date.now();
    await page.close();
  }
  if (!res) throw new Error('详情页 20 秒没返回回复');
  if (rateLimited(res)) { blocked = 'X 接口返回限流'; throw new Error(blocked); }
  const author = work.url.split('/')[3].toLowerCase();
  const replies = [];
  for (const ins of res.body?.data?.threaded_conversation_with_injections_v2?.instructions ?? []) {
    for (const e of ins.entries ?? []) {
      if (!e.entryId.startsWith('conversationthread-')) continue;
      const r = e.content.items?.[0]?.item?.itemContent?.tweet_results?.result;
      const t = r?.tweet ?? r;
      const l = t?.legacy;
      const who = t.core?.user_results?.result?.core?.screen_name ?? t.core?.user_results?.result?.legacy?.screen_name;
      if (!l || l.in_reply_to_status_id_str !== work.id || who?.toLowerCase() === author) continue;
      const note = t.note_tweet?.note_tweet_results?.result;
      const text = tidy(note?.text ?? l.full_text, note?.entity_set?.urls ?? l.entities?.urls, l.entities?.media).replace(/^(@\w+\s+)+/, '');
      if (text) replies.push({ text, likes: n(l.favorite_count) });
    }
  }
  return replies.sort((a, b) => (b.likes ?? 0) - (a.likes ?? 0)).slice(0, 10);
}

export async function copy(ctx, work) {
  const comments = await hotReplies(ctx, work).catch((e) => { ctx.log(`${work.id} 热门回复取不到（${e.message}）`); return []; });
  if (!work.media?.url) {
    if (!work.desc) throw new Error('推文没有文字（纯图片或纯链接）');
    return { source: 'text', text: work.desc, comments };
  }
  ctx.log(`${work.id} 视频推文，转写（${Math.round(work.media.duration ?? 0) || '?'} 秒）`);
  // 推文自带语言（und、zxx 之类由转写那边改成自动识别）；没有人声时转写结果为空
  const speech = (await ctx.asr(work.media.url, { language: work.media.lang })).trim();
  if (!speech) return { source: work.desc ? 'text' : 'asr', text: work.desc, comments };
  return { ...(work.desc ? { source: 'text+asr', text: `${work.desc}\n\n【视频转写】\n${speech}` } : { source: 'asr', text: speech }), comments };
}
