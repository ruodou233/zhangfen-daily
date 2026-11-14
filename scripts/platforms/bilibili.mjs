// B站：zeroroku 滚动 7 日涨粉榜（另取逐日涨粉找峰值日）；分区榜用飞瓜 B站版的分区涨粉日榜（免登录只给前 5 名，
// UID 取自飞瓜详情页）→ 投稿列表（WBI 签名）→ view 数据
// → AI 字幕，没有字幕就取音频转写；热评取热度排序前 10 条。
// api.bilibili.com 的请求都放在无头浏览器的一个空白页里 fetch（真浏览器指纹 + 登录态）：
// Node 直连投稿列表会间歇 412，打开空间页截请求又会被部分账号的主页重定向打断。
import { createHash } from 'node:crypto';

export const label = 'B站';

const API = 'https://api.bilibili.com';
const MAX_WORKS = 10; // 窗口内作品只取最近 10 条去查 view
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
// 网页端投稿列表要带的 dm_img 参数，缺了会 -352
const DM = {
  dm_img_list: '[]',
  dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
  dm_cover_img_str: 'QU5HTEUgKE5WSURJQSwgTlZJRElBIEdlRm9yY2UgR1RYIDEwNTAgVGkgRGlyZWN0M0QxMSB2c181XzAgcHNfNV8wKSwgb3Igc2ltaWxhcg',
  dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}',
};

const DAY = 86_400_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 日期一律按北京时间算，和运行机器的时区无关（写法同 run.mjs）
const TZ = 'Asia/Shanghai';
const dayIn = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const dayNo = (date) => Date.parse(`${date}T00:00:00Z`) / DAY;
const shift = (date, n) => new Date((dayNo(date) + n) * DAY).toISOString().slice(0, 10);
const dayStart = (date) => Date.parse(`${date}T00:00:00+08:00`) / 1000; // 北京时间零点，秒
const cstISO = (sec) => new Date(sec * 1000 + 8 * 3_600_000).toISOString().replace(/\.\d+Z$/, '+08:00');

// 飞瓜 B站版「UP主涨粉榜」的分区（URL 最后一段）。zeroroku 没有分区筛选，按分区取榜走飞瓜：
// 免登录只列前 5 名，日期参数不管用、总是给最新一期
const FG = 'https://bz.feigua.cn';
export const CATEGORIES = {
  动画: 1, 美妆: 3, 时尚: 4, 游戏: 6, 舞蹈: 7, 音乐: 8, 美食: 9, 动物: 10, 生活: 12, 数码: 13, 知识: 14, 娱乐: 15,
  放映厅: 16, 运动: 17, 鬼畜: 20, 汽车: 24, 资讯: 25, 番剧: 29, 科技: 30, 国创: 31, 影视: 32,
};
// '82.2w' → 822000；认不出给 null
const num = (s) => {
  const m = String(s ?? '').replace(/[,+\s]/g, '').match(/^([\d.]+)(w|万|亿)?$/i);
  return m ? Math.round(parseFloat(m[1]) * ({ w: 1e4, 万: 1e4, 亿: 1e8 }[m[2]?.toLowerCase()] ?? 1)) : null;
};

async function feiguaBoard(ctx, category) {
  const cat = CATEGORIES[category];
  if (cat == null) throw new Error(`飞瓜 B站版没有「${category}」这个分区（可选：${Object.keys(CATEGORIES).join('、')}）`);
  const guess = shift(dayIn(Date.now()), -1).replaceAll('-', '');
  const html = await ctx.http.text(`${FG}/ranking/RiseFansv2/${guess}/1/${cat}.html`);
  // 页面实际给的是哪一期：周期按钮组里高亮的「日榜」按钮带着期次
  const ymd = html.match(/el-button--primary\s*"\s*data-date="(\d{8})"\s*data-v="1"/)?.[1];
  if (!ymd) throw new Error('飞瓜 B站版榜单页里没找到日榜期次，页面结构可能变了');
  const rows = [];
  for (const row of html.split('<div class="list-row">').slice(1)) {
    const rank = row.match(/class="rank_index">\s*(\d+)/)?.[1];
    const name = row.match(/<img [^>]*alt="([^"]*)"/)?.[1];
    const detail = row.match(/data-jp="(\/ShowBlogger\/Detail\/\w+)/)?.[1];
    const [followers, gain] = [...row.matchAll(/<div class="col-item[^"]*" style="width: 100px;">([^<]*)<\/div>/g)].map((m) => m[1].trim());
    if (rank && name && detail) rows.push({ rank: +rank, name, gain: num(gain), followers: num(followers), detail });
  }
  if (!rows.length) throw new Error(`飞瓜 B站版 ${ymd} 期「${category}」榜没解析出条目`);
  const entries = [];
  for (const r of rows.slice(0, ctx.opts.top)) {
    await sleep(800);
    const mid = (await ctx.http.text(FG + r.detail)).match(/UID:\s*<span>\s*(\d+)\s*<\/span>/)?.[1];
    if (!mid) { ctx.log(`飞瓜详情页没有 ${r.name} 的 UID，跳过`); continue; }
    entries.push({ rank: r.rank, name: r.name, gain: r.gain, followers: r.followers, ref: { mid } });
  }
  if (ctx.opts.top > rows.length) ctx.log(`飞瓜 B站版免登录只列前 ${rows.length} 名`);
  return {
    date: `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6)}`,
    period: `日榜·${category}（飞瓜前 ${rows.length} 名）`,
    url: `${FG}/ranking/RiseFansv2/${ymd}/1/${cat}.html`,
    entries,
  };
}

export async function board(ctx, { category } = {}) {
  if (category != null) return feiguaBoard(ctx, category);
  const { items } = await ctx.http.json('https://zeroroku.com/api/bilibili/fans-trend?period=7&direction=up');
  if (!items?.length) throw new Error('zeroroku 返回空榜');
  return {
    date: dayIn(Date.now()), // 实时滚动榜，结束日就是今天
    period: '滚动7日',
    url: 'https://zeroroku.com/rank',
    entries: items.slice(0, ctx.opts.top).map((x, i) => ({
      rank: i + 1, name: x.name, gain: x.delta, followers: x.fans, ref: { mid: String(x.mid) },
    })),
  };
}

// 一轮只开一个页面、取一次 WBI 混合 key
let ready;
const bili = (ctx) => (ready ??= (async () => {
  const page = await (await ctx.browser()).open('https://space.bilibili.com/robots.txt', { waitMs: 0 });
  const get = (url) => page.eval(`fetch(${JSON.stringify(url)}, { credentials: 'include' })
    .then((r) => r.ok ? r.json() : { code: 'HTTP ' + r.status })`);
  const { wbi_img } = (await get(`${API}/x/web-interface/nav`)).data;
  const raw = [wbi_img.img_url, wbi_img.sub_url].map((u) => u.split('/').pop().split('.')[0]).join('');
  return { get, mixin: MIXIN.map((i) => raw[i]).join('').slice(0, 32) };
})());

function sign(params, mixin) {
  const p = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(p).sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${q}&w_rid=${createHash('md5').update(q + mixin).digest('hex')}`;
}

async function api(ctx, path, params, { signed = false } = {}) {
  await sleep(400);
  const { get, mixin } = await bili(ctx);
  const j = await get(`${API}${path}?${signed ? sign(params, mixin) : new URLSearchParams(params)}`);
  if (j.code !== 0) throw new Error(`${path} 返回 ${j.code} ${j.message ?? ''}`.trim());
  return j.data;
}

// zeroroku 每天一个快照，rate1 是截至快照的 24 小时涨粉；快照时刻按北京时间归日
async function peakDay(ctx, mid, board) {
  const { items } = await ctx.http.json(`https://zeroroku.com/api/bilibili/author/${mid}/history`);
  const from = shift(board.date, -ctx.opts.window);
  let peak = null;
  for (const x of items ?? []) {
    const date = dayIn(Date.parse(x.createdAt.replace(' ', 'T').replace(/\+00$/, 'Z')));
    if (x.rate1 != null && date >= from && date <= board.date && !(peak?.gain >= x.rate1)) peak = { date, gain: x.rate1 };
  }
  return peak;
}

// 主页链接 → mid（space.bilibili.com/<mid>）；b23.tv 短链跟随跳转
export async function parseUrl(ctx, url) {
  let u = url.trim();
  if (/b23\.tv/.test(u)) {
    const res = await ctx.http.request(u, { redirect: 'manual' });
    u = res.headers.get('location') || u;
  }
  const mid = u.match(/space\.bilibili\.com\/(\d+)/)?.[1];
  if (!mid) throw new Error('认不出 B站主页链接（要 space.bilibili.com/ 开头的个人空间地址）');
  return { mid };
}

export async function works(ctx, entry, board) {
  const { mid } = entry.ref;
  const peak = await peakDay(ctx, mid, board).catch((e) => { ctx.log(`${entry.name} 逐日涨粉取不到（${e.message}）`); return null; });
  // 卡片接口：认证类型（Official.type：1 机构认证，0 个人认证，-1 没认证），指定账号模式还要靠它补粉丝数
  const card = await api(ctx, '/x/web-interface/card', { mid }).catch((e) => { ctx.log(`${entry.name} 卡片接口失败（${e.message}）`); return null; });
  const followers = entry.followers ?? card?.follower ?? null;
  const official = card?.card?.Official?.type;
  const org = official == null ? null : official === 1;
  const data = await api(ctx, '/x/space/wbi/arc/search',
    { mid, ps: 30, pn: 1, order: 'pubdate', platform: 'web', web_location: 1550101, order_avoided: 'true', ...DM }, { signed: true });
  const vlist = data.list?.vlist ?? [];

  const end = dayStart(shift(board.date, 1)) - 1;
  const start = dayStart(shift(board.date, -ctx.opts.window));
  const inWindow = vlist.filter((v) => v.created >= start && v.created <= end);
  // 最近 10 条，再加上峰值日及前 3 天发布的，让峰值规则有机会命中
  const peakFrom = peak && dayStart(shift(peak.date, -3));
  const peakTo = peak && dayStart(shift(peak.date, 1)) - 1;
  const extra = peak ? inWindow.slice(MAX_WORKS).filter((v) => v.created >= peakFrom && v.created <= peakTo) : [];
  const notes = [];
  if (inWindow.length > MAX_WORKS) {
    notes.push(`窗口内 ${inWindow.length}${inWindow.length === vlist.length ? '+' : ''} 条，只取最近 ${MAX_WORKS} 条${extra.length ? `和峰值日前后 ${extra.length} 条` : ''}`);
  }

  const list = [];
  for (const v of [...inWindow.slice(0, MAX_WORKS), ...extra]) {
    let d = null;
    try {
      d = await api(ctx, '/x/web-interface/view', { bvid: v.bvid });
    } catch (e) {
      notes.push(`${v.bvid} 详情取不到（${e.message}），用列表数据`);
    }
    const s = d?.stat;
    list.push({
      id: v.bvid,
      url: `https://www.bilibili.com/video/${v.bvid}`,
      title: d?.title ?? v.title,
      type: 'video',
      published_at: cstISO(d?.pubdate ?? v.created),
      duration: d?.duration ?? (v.length ? v.length.split(':').reduce((t, x) => t * 60 + +x, 0) : null), // 列表的 length 是 'mm:ss'
      metrics: {
        plays: s?.view ?? v.play ?? null,
        likes: s?.like ?? null,
        comments: s?.reply ?? v.comment ?? null,
        collects: s?.favorite ?? null,
        shares: s?.share ?? null,
      },
      desc: d?.desc ?? v.description ?? '',
      media: d && { bvid: v.bvid, aid: d.aid, cid: d.cid },
    });
  }

  return {
    creator: { id: mid, name: vlist[0]?.author ?? entry.name, url: `https://space.bilibili.com/${mid}`, followers, org },
    works: list,
    note: notes.join('；'),
    peak,
  };
}

async function hotComments(ctx, aid) {
  const data = await api(ctx, '/x/v2/reply/wbi/main',
    { oid: aid, type: 1, mode: 3, pagination_str: '{"offset":""}', plat: 1, web_location: 1315875 }, { signed: true });
  // 热度排序里夹着新评论，按赞数重排再取前 10
  return (data.replies ?? []).map((r) => ({ text: r.content?.message ?? '', likes: r.like ?? 0 }))
    .sort((x, y) => y.likes - x.likes).slice(0, 10);
}

export async function copy(ctx, work) {
  if (!work.media) throw new Error('缺 cid，取不了字幕和音频');
  const { bvid, aid, cid } = work.media;
  const comments = await hotComments(ctx, aid).catch((e) => { ctx.log(`${bvid} 热评取不到（${e.message}）`); return []; });

  // player/v2 的字幕列表常为空，dm/view 里能拿到 AI 字幕地址；人工中文字幕优先
  const subs = (await api(ctx, '/x/v2/dm/view', { type: 1, oid: cid, pid: aid })).subtitle?.subtitles ?? [];
  const sub = subs.find((s) => /^zh/.test(s.lan)) ?? subs.find((s) => s.lan === 'ai-zh') ?? subs[0];
  if (sub?.subtitle_url) {
    const body = await ctx.http.json(sub.subtitle_url.replace(/^(https?:)?\/\//, 'https://'));
    const text = (body.body ?? []).map((x) => x.content).join('\n').trim();
    if (text) return { source: 'subtitle', text, comments };
  }

  const play = await api(ctx, '/x/player/playurl', { bvid, cid, fnval: 16, fourk: 0 });
  const audio = (play.dash?.audio ?? []).sort((a, b) => a.bandwidth - b.bandwidth)[0];
  const url = audio?.baseUrl ?? audio?.base_url ?? play.durl?.[0]?.url;
  if (!url) throw new Error('没有字幕，也取不到音频地址');
  ctx.log(`${bvid} 无字幕，转写音频（${work.duration ?? '?'} 秒）`);
  return { source: 'asr', text: await ctx.asr(url, { headers: { Referer: 'https://www.bilibili.com/' }, language: 'zh' }), comments };
}
