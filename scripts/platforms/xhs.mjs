// 小红书：千瓜日涨粉榜（免登录 HTTP）→ 浏览器里按昵称站内搜索，用头像 key / 昵称 / 粉丝量确认身份
// → 创作者主页首屏笔记（带 xsec_token 和发布时间）→ 窗口内点赞最高的 --copy 条打开详情取正文、互动数据、视频地址。
// 文案 = 标题 + 正文，视频笔记再加转写；热评取详情页自己加载的第一页评论。确认过的身份缓存在 <out>/cache/xhs_user.json，再上榜直接开主页复核。
import fs from 'node:fs';
import path from 'node:path';

export const label = '小红书';

const QG = 'https://www.qian-gua.com';
const XHS = 'https://www.xiaohongshu.com';
const DAY = 86_400_000;
const CST = 8 * 3_600_000;
const SEARCH_API = /\/api\/sns\/web\/v\d\/search\/(onebox|usersearch|notes)/;
const COMMENT_API = /\/api\/sns\/web\/v\d\/comment\/page/;
const RISK = /IP存在风险|安全验证|访问频繁|账号异常|安全限制|captcha/i;

const rankUrl = (ymd) => `${QG}/rank/fans/1/1/${ymd}/0.html`;
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const cstISO = (ms) => new Date(ms + CST).toISOString().replace(/\.\d+Z$/, '+08:00');
const unescape = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const clean = (html = '') => unescape(html.replace(/<i[\s\S]*?<\/i>/g, '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
// '4.18万' → 41800，'10万+' → 100000，'1.6M' → 1600000；认不出给 null
const num = (s) => {
  const m = String(s ?? '').replace(/[,+\s]/g, '').match(/^([\d.]+)(w|万|亿|k|m)?$/i);
  return m ? Math.round(parseFloat(m[1]) * ({ w: 1e4, 万: 1e4, 亿: 1e8, k: 1e3, m: 1e6 }[m[2]?.toLowerCase()] ?? 1)) : null;
};
// 只留字母数字和汉字再比：千瓜会丢掉昵称里的 emoji 和空格
const norm = (s) => String(s ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const avatarKey = (url) => String(url ?? '').match(/\/avatar\/([^/?.\s"]+)/)?.[1] ?? null;

// ---------- 榜单 ----------

// 千瓜页面脚本里的 dateCode 是已发布期次列表（第一项最新）；未发布的日期请求回来是空表
function periods(html) {
  const raw = html.match(/var dateCode = JSON\.parse\('(.*?)'\)/)?.[1];
  try { return JSON.parse(raw).map((d) => String(d.Datecode)).sort().reverse(); } catch { return []; }
}

function rows(html) {
  const tbody = html.split('<table class="table-list">')[1]?.split('</tbody>')[0] ?? '';
  const out = [];
  for (const [tr] of tbody.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)) {
    const rank = tr.match(/class="r-(?:icon[^"]*|num)">\s*(\d+)/)?.[1];
    const name = clean(tr.match(/<span class="name">([\s\S]*?)<\/span>/)?.[1]);
    if (!rank || !name) continue;
    const tds = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => clean(m[1]));
    const tags = [...tr.matchAll(/<p class="prop">([\s\S]*?)<\/p>/g)].flatMap((m) => clean(m[1]).split('|')).map((s) => s.replace(/\s*：\s*/, '：').trim()).filter(Boolean);
    out.push({
      rank: +rank, name, gain: num(tds[5]), followers: num(tds[3]),
      ref: { avatar: tr.match(/\/avatar\/([^"\s?]+?)(?:\.jpg)?(?:-\d+x\d+)?"/)?.[1] ?? null, tags },
    });
  }
  return out;
}

export async function board(ctx) {
  // 先猜昨天（北京时间）；期次列表的第一项不是它就改取那一期
  let ymd = cstISO(Date.now() - DAY).slice(0, 10).replaceAll('-', '');
  let html = await ctx.http.text(rankUrl(ymd));
  const latest = periods(html)[0];
  if (!latest) throw new Error('千瓜页面里没找到期次列表，榜期获取失败');
  if (latest !== ymd) {
    ctx.log(`千瓜 ${ymd} 期还没发布，改取最新一期 ${latest}`);
    ymd = latest;
    html = await ctx.http.text(rankUrl(ymd));
  }
  const entries = rows(html);
  if (!entries.length) throw new Error(`千瓜 ${ymd} 期榜单是空表`);
  return {
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`,
    period: '日榜',
    url: rankUrl(ymd),
    entries: entries.slice(0, ctx.opts.top),
  };
}

// ---------- 浏览器 ----------

let blocked = null; // 一旦碰到验证码 / 风险提示，本轮不再访问小红书
let lastSeen = 0; // 上一个页面就绪的时刻；下一个页面距它留 1–3 秒，中间已经过去的时间（如转写）照算

// 风控页 / 404 页识别。只看路径、404 页的 error_msg 和正文开头，不看标题和查询串（搜索词本身可能撞上关键词）
const PROBE_JS = `(()=>{const q=new URLSearchParams(location.search);
  const m=(location.pathname+' '+(q.get('error_msg')||'')+' '+(document.body?.innerText||'').slice(0,300)).match(${RISK});
  if(m)return {risk:m[0]};if(location.pathname.startsWith('/404'))return {gone:q.get('error_msg')||'404'};return null})()`;

// 打开页面但不等 load（要等全部封面图下完，很慢）：导航后轮询，ready(page) 有值、落到 404 或出现风控就返回。
// 返回 { page, value | gone }，page 由调用方关闭；超时则两者都没有。
async function visit(ctx, url, ready, capture = []) {
  if (blocked) throw new Error(`小红书本轮已停止访问（${blocked}）`);
  await sleep(lastSeen + 1000 + Math.random() * 2000 - Date.now());
  const page = await (await ctx.browser()).open('about:blank', { capture, waitMs: 0 });
  let got;
  try {
    await page.send('Page.navigate', { url });
    got = await page.waitFor(async () => {
      try {
        const s = await page.eval(PROBE_JS);
        if (s) return s;
        const value = await ready(page);
        return value ? { value } : null;
      } catch { return null; } // 导航中执行上下文会被销毁，下一轮再试
    }, 15_000).catch(() => ({}));
    lastSeen = Date.now();
  } catch (e) {
    await page.close();
    throw e;
  }
  if (got.risk) {
    await page.close();
    blocked = `出现「${got.risk}」`;
    ctx.log(`小红书触发风控：${blocked}，停止本轮后续访问`);
    throw new Error(`小红书触发风控（${blocked}），停止访问`);
  }
  return { page, ...got };
}

// 搜索页接口里的候选账号：onebox（精确命中的用户卡）、usersearch（用户 tab）、notes（笔记作者，无粉丝数）
function candidates(responses) {
  const byId = new Map();
  const add = (u) => {
    if (!u.id) return;
    const old = byId.get(u.id) ?? {};
    for (const [k, v] of Object.entries(u)) if (v != null && v !== '' && old[k] == null) old[k] = v;
    byId.set(u.id, old);
  };
  for (const { url, body } of responses) {
    const d = body?.data;
    if (/onebox/.test(url)) for (const { user_one_box: u } of d?.onebox_list ?? []) {
      if (u) add({ id: u.id, name: u.title, fans: num(u.fans), avatar: avatarKey(u.image) });
    }
    if (/usersearch/.test(url)) for (const u of d?.users ?? []) {
      add({ id: u.id, name: u.name, fans: num(u.fans), avatar: avatarKey(u.image) });
    }
    if (/notes/.test(url)) for (const it of d?.items ?? []) {
      const u = it.note_card?.user;
      if (u) add({ id: u.user_id, name: u.nickname ?? u.nick_name, avatar: avatarKey(u.avatar) });
    }
  }
  return [...byId.values()];
}

// 头像 key、昵称、粉丝量三项里至少两项吻合，且得分最高的只有一个，才算确认
function pick(entry, cands) {
  const fansOk = (f) => entry.followers && f >= entry.followers * 0.9 && f <= entry.followers * 1.1 + 3 * (entry.gain ?? 0);
  const scored = cands.map((c) => ({
    ...c,
    signals: [
      entry.ref?.avatar && c.avatar === entry.ref.avatar && '头像',
      norm(entry.name) && norm(c.name) === norm(entry.name) && '昵称',
      c.fans != null && fansOk(c.fans) && '粉丝量',
    ].filter(Boolean),
  })).sort((a, b) => b.signals.length - a.signals.length);
  const [best, next] = scored;
  if (best?.signals.length >= 2 && !(next?.signals.length === best.signals.length)) return { user: best };
  if (best?.signals.length >= 2) return { why: `有多个账号同样吻合（${scored.filter((c) => c.signals.length === best.signals.length).map((c) => c.name).join('、')}），无法区分` };
  const near = scored.filter((c) => c.signals.length).slice(0, 3).map((c) => `${c.name}[${c.signals}${c.fans != null ? ` ${c.fans}粉` : ''}]`);
  return { why: `站内搜索「${entry.name}」的 ${cands.length} 个候选账号里没有头像/昵称/粉丝量两项以上吻合的${near.length ? `（只有一项吻合：${near.join('、')}）` : ''}` };
}

async function findUser(ctx, entry) {
  const has = (p, re) => p.responses.some((r) => re.test(r.url));
  for (let tries = 1; ; tries++) {
    if (tries > 1) await sleep(3000);
    const { page } = await visit(ctx, `${XHS}/search_result?keyword=${encodeURIComponent(entry.name)}&source=web_explore_feed`,
      (p) => has(p, /onebox/) && has(p, /notes/), [SEARCH_API]);
    try {
      // 偶尔搜索接口一个都没回来，同一会话里隔几秒再试一次
      if (!page.responses.length) {
        if (tries === 1) { ctx.log(`搜索「${entry.name}」没有返回结果接口，几秒后重试一次`); continue; }
        throw new Error('搜索页两次都没有返回任何结果接口');
      }
      return await searchHit(ctx, entry, page, has);
    } finally {
      await page.close();
    }
  }
}

async function searchHit(ctx, entry, page, has) {
  let hit = pick(entry, candidates(page.responses));
  if (!hit.user) {
    // 用户卡没直接命中，切到「用户」tab 看完整的用户搜索结果
    await page.eval(`[...document.querySelectorAll('.channel')].find(e=>e.textContent.trim()==='用户')?.click()`);
    await page.waitFor(() => has(page, /usersearch/), 10_000).catch(() => {});
    hit = pick(entry, candidates(page.responses));
  }
  const bad = page.responses.find((r) => r.body && typeof r.body === 'object' && r.body.success === false && RISK.test(r.body.msg ?? ''));
  if (bad) { blocked = `搜索接口返回「${bad.body.msg}」`; throw new Error(`小红书触发风控（${blocked}），停止访问`); }
  if (!hit.user) throw new Error(hit.why);
  return hit.user;
}

// 身份缓存：键是千瓜头像 key（没有就用榜单昵称），值 { id, name: 小红书昵称, qg_name: 榜单昵称 }
const cacheFile = (ctx) => path.join(ctx.opts.out, 'cache', 'xhs_user.json');
function readCache(ctx) {
  try { return JSON.parse(fs.readFileSync(cacheFile(ctx), 'utf8')); } catch { return {}; }
}
function remember(ctx, entry, user) {
  const cache = readCache(ctx);
  cache[entry.ref?.avatar || entry.name] = { id: user.id, name: user.name, qg_name: entry.name };
  fs.mkdirSync(path.dirname(cacheFile(ctx)), { recursive: true });
  fs.writeFileSync(cacheFile(ctx), JSON.stringify(cache, null, 1));
}

// ---------- 作品 ----------

// 主页数据就绪才返回：资料在、且笔记列表非空（posted 为 0 的账号除外）。列表一般随页面直出，
// 偶尔要等前端自己拉第一页，这期间资料已经有了而列表还是空的，过早读会得到"窗口内 0 条"。
const PROFILE_JS = `(()=>{const un=x=>x&&(x._rawValue??x._value??x);const u=window.__INITIAL_STATE__?.user;const d=un(u?.userPageData);
  if(!d?.basicInfo)return null;const notes=un(u.notes);const first=(Array.isArray(notes)&&Array.isArray(notes[0])?notes[0]:[]).map(un);
  if(!first.length&&d.posted!==0)return null;
  return {name:d.basicInfo.nickname,avatar:d.basicInfo.images,fans:(d.interactions||[]).find(i=>i.type==='fans')?.count,
    notes:first.map(n=>({id:n.noteCard?.noteId||n.id,token:n.xsecToken||n.noteCard?.xsecToken,
      title:n.noteCard?.displayTitle,type:n.noteCard?.type,time:n.noteCard?.time,likes:n.noteCard?.interactInfo?.likedCount}))}})()`;

// 视频取带音轨的 mp4 里码率最低的一路（.m4s 是 DASH 纯视频流，没有声音）
const noteJs = (id) => `(()=>{const un=x=>x&&(x._rawValue??x._value??x);const n=un(window.__INITIAL_STATE__?.note?.noteDetailMap)?.[${JSON.stringify(id)}]?.note;
  if(!n?.noteId)return null;const all=Object.values(n.video?.media?.stream||{}).flat().filter(s=>s?.masterUrl);
  const mp4=all.filter(s=>s.format==='mp4'&&s.audioCodec);
  const rate=(s)=>s.avgBitrate||s.videoBitrate||s.size||1e15;const v=(mp4.length?mp4:all).sort((a,b)=>rate(a)-rate(b))[0];
  return {title:n.title,desc:n.desc,type:n.type,time:n.time,i:n.interactInfo,video:v?{url:v.masterUrl,duration:n.video?.capa?.duration??null}:null}})()`;

// 正文里的话题标记 '#xxx[话题]#' 还原成 '#xxx'
const tidy = (s) => (s ?? '').replace(/#([^#\n]+?)\[话题\]#/g, '#$1 ').replace(/^[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

const hot = new Map(); // 笔记 id → 热评，copy() 时交给 run.mjs

async function fillDetail(ctx, work) {
  const { page, value: d, gone } = await visit(ctx, work.url, (p) => p.eval(noteJs(work.id)), [COMMENT_API]);
  try {
    if (!d) throw new Error(gone ? `笔记打不开（${gone}）` : '笔记详情 15 秒内没加载出来');
    work.title = d.title || work.title;
    work.type = d.type === 'video' ? 'video' : 'note';
    if (d.time) work.published_at = cstISO(d.time);
    work.metrics = { plays: null, likes: num(d.i?.likedCount), comments: num(d.i?.commentCount), collects: num(d.i?.collectedCount), shares: num(d.i?.shareCount) };
    work.desc = tidy(d.desc);
    work.media = d.video && { url: d.video.url, duration: d.video.duration, headers: { Referer: `${XHS}/` } };
    // 评论接口先有一次 CORS 预检（没有响应体），等带 comments 的那次
    const res = await page.waitFor(() => page.responses.find((r) => r.body?.data?.comments), 6000).catch(() => null);
    hot.set(work.id, (res?.body.data.comments ?? []).map((c) => ({ text: c.content ?? '', likes: num(c.like_count) ?? 0 }))
      .sort((a, b) => b.likes - a.likes).slice(0, 10));
  } finally {
    await page.close();
  }
}

// 搜索确认和缓存复核两条路径都用同一个地址新开主页（登录态下不带 xsec_token 也能打开），首屏笔记一就绪就读，不等页面自己往下加载
async function loadProfile(ctx, id) {
  const { page, value, gone } = await visit(ctx, `${XHS}/user/profile/${id}`, (p) => p.eval(PROFILE_JS));
  await page.close();
  if (!value) throw new Error(`账号 ${id} 的主页${gone ? `打不开（${gone}）` : '资料或笔记列表 15 秒内没加载出来'}`);
  if (value.notes.length && !value.notes.some((n) => n.token)) throw new Error(`账号 ${id} 主页的笔记都没有 xsec_token，打不开详情`);
  return value;
}

export async function works(ctx, entry, board) {
  let user, profile, via = '搜索';
  const cache = readCache(ctx);
  const cached = cache[entry.ref?.avatar] ?? Object.values(cache).find((c) => norm(c.qg_name) === norm(entry.name));
  if (cached) {
    // 缓存命中：直接开主页，用主页上的头像 / 昵称 / 粉丝量按同样标准复核，不吻合再去搜索
    profile = await loadProfile(ctx, cached.id).catch((e) => { if (blocked) throw e; ctx.log(`${entry.name} 缓存的${e.message}，改走搜索`); return null; });
    const check = profile && pick(entry, [{ id: cached.id, name: profile.name, fans: num(profile.fans), avatar: avatarKey(profile.avatar) }]);
    if (check?.user) [user, via] = [check.user, '缓存复核'];
    else if (profile) { ctx.log(`${entry.name} 缓存的账号 ${cached.id}（${profile.name}）复核不吻合，改走搜索`); profile = null; }
  }
  if (!user) {
    user = await findUser(ctx, entry);
    profile = await loadProfile(ctx, user.id);
  }
  ctx.log(`${entry.name} → ${user.name}（${user.id}，${via}：${user.signals.join('+')}吻合）`);
  remember(ctx, entry, user);

  const start = Date.parse(`${board.date}T00:00:00+08:00`) - ctx.opts.window * DAY;
  const end = Date.parse(`${board.date}T00:00:00+08:00`) + DAY;
  const list = profile.notes
    .filter((n) => n.id && n.token)
    // 主页卡片带发布时间；万一缺了，笔记 id 前 8 位就是创建时间戳
    .map((n) => ({ ...n, time: n.time ?? parseInt(n.id.slice(0, 8), 16) * 1000 }))
    .filter((n) => n.time >= start && n.time < end)
    .map((n) => ({
      id: n.id,
      url: `${XHS}/explore/${n.id}?xsec_token=${encodeURIComponent(n.token)}&xsec_source=pc_user`,
      title: n.title ?? '',
      type: n.type === 'video' ? 'video' : 'note',
      published_at: cstISO(n.time),
      metrics: { plays: null, likes: num(n.likes), comments: null, collects: null, shares: null },
      desc: null,
      media: null,
    }));

  const notes = [];
  // 只为点赞最高、会被选作代表作的几条开详情；其余保留卡片上的点赞数和发布时间
  const top = [...list].sort((a, b) => (b.metrics.likes ?? -1) - (a.metrics.likes ?? -1)).slice(0, ctx.opts.copy ?? 2);
  if (list.length > top.length) ctx.log(`${entry.name}：窗口内 ${list.length} 条（主页首屏 ${profile.notes.length} 条），只为点赞前 ${top.length} 条取详情`);
  for (const w of top) {
    if (Date.now() > ctx.deadline) { notes.push('预算用完，详情没取完'); break; }
    try {
      await fillDetail(ctx, w);
    } catch (e) {
      if (blocked) throw e;
      notes.push(`${w.id} 详情取不到（${e.message}）`);
    }
  }

  return {
    creator: { id: user.id, name: profile.name ?? user.name, url: `${XHS}/user/profile/${user.id}`, followers: num(profile.fans) ?? user.fans ?? null },
    works: list,
    note: notes.join('；'),
  };
}

export async function copy(ctx, work) {
  if (work.desc == null) await fillDetail(ctx, work); // works() 里没开过详情的，这时补开
  const text = [work.title, work.desc].map((s) => s?.trim()).filter(Boolean).join('\n\n');
  const comments = hot.get(work.id) ?? [];
  if (work.type !== 'video') return { source: 'text', text, comments };
  if (!work.media?.url) throw new Error('没取到视频地址');
  ctx.log(`${work.id} 视频笔记，转写（${work.media.duration ?? '?'} 秒）`);
  const asr = (await ctx.asr(work.media.url, { headers: work.media.headers, language: 'zh' })).trim(); // 没转出有效语音时为空
  return { source: 'text+asr', text: asr ? `${text}\n\n【视频转写】\n${asr}`.trim() : text, comments };
}
