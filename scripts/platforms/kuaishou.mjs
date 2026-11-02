// 快手：新榜快手涨粉日榜（要新榜登录态；没登录退回新快免登录预览，只有近 7 天涨粉前 3）
// → 按快手号（或缓存的主页 id）在浏览器里打开快手直播站主页（免登录），页面接口给出 userId 复核身份、首屏作品
// → 代表作再开 www.kuaishou.com 作品页补描述和精确发布时间 → 文案 = 描述 + 视频转写。
import fs from 'node:fs';
import path from 'node:path';

export const label = '快手';

const LIVE = 'https://live.kuaishou.com';
const DAY = 86_400_000;
const CST = 8 * 3_600_000;
const PUBLIC = /live_api\/profile\/public/;
const USER = /live_api\/baseuser\/userinfo\/byid/;
const SEARCH = /live_api\/search\/author/;

// 两个榜单接口同一个后端、同样的字段；N-Token 是前端包里的公开常量
const RANKS = {
  day: {
    api: 'https://gw.newrank.cn/api/mainRank/nr/mainRank/new/rank/ksRiseFansRank',
    token: '3b2f8f99af0545cc989cfae76477d9bf', origin: 'https://www.newrank.cn',
    url: 'https://www.newrank.cn/rankfans/kuaishou', period: '日榜', sort: 'addFanCountYesterdayRecent',
  },
  preview: {
    api: 'https://gw.newrank.cn/api/xk/xdnphb/nr/cloud/ks/rank/accountWithHotCount',
    token: '96a7725673b545599bb1ec18898ad603', origin: 'https://xk.newrank.cn',
    url: 'https://xk.newrank.cn/account/singleRank/fansUp', period: '滚动7日', sort: 'addFanCountSevenRecent',
  },
};

const cstISO = (ms) => new Date(ms + CST).toISOString().replace(/\.\d+Z$/, '+08:00');
// '121.3w' / '6.3万' / '3589' → 数值；认不出给 null
const num = (s) => {
  const m = String(s ?? '').replace(/[,+\s]/g, '').match(/^([\d.]+)(w|万|亿)?$/i);
  return m ? Math.round(parseFloat(m[1]) * ({ w: 1e4, 万: 1e4, 亿: 1e8 }[m[2]?.toLowerCase()] ?? 1)) : null;
};
const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1) || (y.metrics?.plays ?? -1) - (x.metrics?.plays ?? -1);

async function rank(ctx, r, cookie = '') {
  const res = await ctx.http.request(r.api, {
    method: 'POST',
    headers: { 'N-Token': r.token, 'Content-Type': 'application/json;charset=UTF-8', Origin: r.origin, Referer: `${r.origin}/`, Cookie: cookie },
    body: JSON.stringify({ start: 1, size: 20, sort: r.sort, type: '' }),
  });
  return res.json();
}

export async function board(ctx) {
  // 新榜主站的快手涨粉榜对注册用户免费，登录态从日常 Chrome 复制
  const cookie = await (await ctx.browser()).cookieHeader('gw.newrank.cn');
  let r = RANKS.day;
  let res = await rank(ctx, r, cookie);
  if (res.code === 401) {
    ctx.log('新榜未登录，拿不到快手涨粉日榜；改用新快免登录预览（近 7 天涨粉前 3）。在日常 Chrome 登录 newrank.cn 后重跑即可取日榜');
    r = RANKS.preview;
    res = await rank(ctx, r);
  }
  const list = res.data?.list;
  if (res.code !== 2000 || !list?.length) throw new Error(`新榜快手涨粉榜返回 code=${res.code} ${res.msg ?? ''}`.trim());
  // rank_date（每行也有 rankDate）是数据所属日期，近 7 天榜是窗口结束日；接口每天中午前后更新
  const date = String(res.data.rank_date ?? list[0].rankDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('新榜快手涨粉榜没有 rank_date，无法确认榜期');
  return {
    date,
    period: r.period,
    url: r.url,
    entries: list.slice(0, ctx.opts.top).map((x, i) => ({
      rank: i + 1, name: x.name, gain: num(x[r.sort]), followers: num(x.fan),
      ref: { userId: String(x.userId), kwaiId: x.kwaiId || null },
    })),
  };
}

// 打开快手直播站主页（免登录）。页面自己带签名请求用户信息和首屏作品；id 可以是快手号或 eid，
// 用户信息里的 originUserId 就是榜单给的数字 userId。直接 HTTP 调这两个接口没几次就会弹验证码
async function profile(ctx, id) {
  const page = await (await ctx.browser()).open(`${LIVE}/profile/${encodeURIComponent(id)}`, { capture: [USER, PUBLIC], waitMs: 0 });
  const got = (re) => page.responses.find((r) => re.test(r.url))?.body?.data;
  try {
    await page.waitFor(() => got(USER) && got(PUBLIC), 20_000).catch(() => null);
    return { user: got(USER)?.userInfo, feed: got(PUBLIC) };
  } finally {
    await page.close();
  }
}

// 榜单 userId → 直播站主页 id。按 userId 缓存在 <out>/cache/kuaishou_user.json，每次打开主页时用 userId 复核
async function resolve(ctx, entry) {
  const { userId, kwaiId } = entry.ref;
  const file = path.join(ctx.opts.out, 'cache', 'kuaishou_user.json');
  const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let found;
  for (const id of new Set([cache[userId], kwaiId].filter(Boolean))) {
    const p = await profile(ctx, id);
    if (String(p.user?.originUserId) === userId) { found = { id, ...p }; break; }
    ctx.log(`${entry.name}：${id} 的主页${p.user?.originUserId ? `是 userId=${p.user.originUserId}` : '不存在或没打开'}，不是 ${userId}`);
  }
  found ??= await searchUser(ctx, entry);
  if (cache[userId] !== found.id) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...cache, [userId]: found.id }, null, 1));
  }
  return found;
}

// 没设快手号的作者只能站内搜昵称；快手直播站的作者搜索要登录（登录后的结果未实测，候选一律打开主页用 userId 复核）
async function searchUser(ctx, entry) {
  const session = await ctx.browser();
  if (!(await session.cookieHeader('live.kuaishou.com')).includes('kuaishou.live.web_st=')) {
    throw new Error(`没有可用的快手号，免登录无法从 userId=${entry.ref.userId} 找到主页（日常 Chrome 登录 live.kuaishou.com 后可站内搜索）`);
  }
  const page = await session.open(`${LIVE}/search/?keyword=${encodeURIComponent(entry.name)}`, { capture: [SEARCH], waitMs: 0 });
  let list;
  try {
    list = (await page.waitFor(() => page.responses[0], 15_000).catch(() => null))?.body?.data?.list ?? [];
  } finally {
    await page.close();
  }
  for (const id of [...new Set(list.map((u) => u.principalId ?? u.id).filter(Boolean))].slice(0, 5)) {
    const p = await profile(ctx, id);
    if (String(p.user?.originUserId) === entry.ref.userId) return { id, ...p };
  }
  throw new Error(`快手搜索“${entry.name}”的前几个结果里没有 userId=${entry.ref.userId} 的账号`);
}

// 列表里没有发布时间：封面文件名 B<base64>_ 里编码了上传时间（北京时间，一般比发布早十几秒）
function uploadedAt(poster) {
  const b64 = String(poster).match(/\/upic\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/B([A-Za-z0-9+/=]+?)_/)?.[1];
  const t = b64 && Buffer.from(b64, 'base64').toString('latin1').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/);
  return t ? Date.parse(`${t[1]}-${t[2]}-${t[3]}T${t[4]}:${t[5]}:${t[6]}+08:00`) : null;
}

function toWork(x) {
  const c = x.counts ?? {};
  const time = uploadedAt(x.poster);
  const isVideo = x.workType === 'video' && x.playUrl;
  return {
    id: x.id,
    url: `https://www.kuaishou.com/short-video/${x.id}`,
    title: '',
    type: isVideo ? 'video' : 'note',
    published_at: time ? cstISO(time) : null,
    metrics: { plays: num(c.displayView), likes: c.like ?? num(c.displayLike), comments: num(c.displayComment), collects: null, shares: null },
    desc: '',
    media: isVideo ? { url: x.playUrl, headers: { Referer: `${LIVE}/` } } : null,
  };
}

// www.kuaishou.com 作品页（免登录）服务端渲染的 __APOLLO_STATE__ 里有描述、精确发布时间、时长；图文作品不给。
// 不带 Cookie 的纯 HTTP 请求几次之后服务端就不再渲染详情，所以也在浏览器里开
async function detail(ctx, id) {
  const page = await (await ctx.browser()).open(`https://www.kuaishou.com/short-video/${id}`, { waitMs: 0 });
  try {
    return await page.eval(`((d) => d && { caption: d.caption, timestamp: d.timestamp, duration: d.duration })
      (window.__APOLLO_STATE__?.defaultClient?.[${JSON.stringify(`VisionVideoDetailPhoto:${id}`)}])`);
  } finally {
    await page.close();
  }
}

export async function works(ctx, entry, board) {
  const { id, user, feed: data } = await resolve(ctx, entry);
  const url = `${LIVE}/profile/${id}`;
  if (!data) throw new Error('快手直播站主页 20 秒内没返回作品列表');
  // result=2：同一主页短时间内开多了会被限流，隔几分钟就好
  if (data.result !== 1) throw new Error(`作品列表接口返回 result=${data.result}${data.result === 2 ? '（访问太频繁，过几分钟再跑）' : ''}`);

  // 免登录只给首屏一页（十几条），按上传时间倒序
  const end = Date.parse(`${board.date}T23:59:59.999+08:00`);
  const start = end + 1 - (ctx.opts.window + 1) * DAY;
  // 主页里也会出现别人发的共创作品（作者不是本人），只算本人发的
  const list = data.list ?? [];
  const own = list.filter((x) => x.author?.id === user.id);
  if (own.length < list.length) ctx.log(`${entry.name}：主页首屏有 ${list.length - own.length} 条是别人发的共创作品，不计入`);
  const all = own.map(toWork);
  const times = all.map((w) => Date.parse(w.published_at)).filter((t) => t);
  const inWindow = all.filter((w) => { const t = Date.parse(w.published_at); return t >= start && t <= end; });
  ctx.log(`${entry.name}：主页首屏本人作品 ${all.length} 条，窗口内 ${inWindow.length} 条`);

  // 代表作（与 run.mjs 同样按点赞取前 --copy 条）补描述和精确时间；其余作品只有列表数据
  for (const w of [...inWindow].sort(byLikes).slice(0, ctx.opts.copy)) {
    if (w.type !== 'video') continue;
    const d = await detail(ctx, w.id).catch((e) => { ctx.log(`  ${w.id} 作品页打开失败：${e.message}`); return null; });
    if (!d) { ctx.log(`  ${w.id} 作品页里没有作品详情，只用列表数据`); continue; }
    w.desc = (d.caption || '').replace(/@([^@(\s]+)\(O[0-9a-z]+\)/g, '@$1').trim(); // @昵称(O<eid>) 是 @ 提及的写法
    w.title = w.desc.split('\n')[0].slice(0, 60);
    if (d.timestamp) w.published_at = cstISO(d.timestamp);
    if (d.duration) w.media.duration = d.duration / 1000;
  }

  const oldest = Math.min(...times);
  const more = data.pcursor && data.pcursor !== 'no_more';
  return {
    creator: { id: entry.ref.userId, name: user.name || entry.name, url, followers: entry.followers },
    works: inWindow,
    note: [
      times.length < all.length && `${all.length - times.length} 条作品认不出发布时间，未计入`,
      more && times.length && oldest > start && (oldest > end ? `主页首屏 ${list.length} 条都在榜期之后，免登录翻不到窗口内作品` : `免登录只能取主页首屏 ${list.length} 条，窗口内至少 ${inWindow.length} 条`),
    ].filter(Boolean).join('；'),
  };
}

export async function copy(ctx, work) {
  if (!work.media?.url) {
    if (!work.desc) throw new Error('快手图文作品网页端免登录拿不到文字说明');
    return { source: 'text', text: work.desc };
  }
  // asr 没有人声时返回空串，这时只用描述
  const speech = (await ctx.asr(work.media.url, { headers: work.media.headers })).trim();
  if (!speech && !work.desc) throw new Error('没有描述，视频里也没有人声');
  if (!speech) return { source: 'text', text: work.desc };
  if (!work.desc) return { source: 'asr', text: speech };
  return { source: 'text+asr', text: `${work.desc}\n\n${speech}` };
}
