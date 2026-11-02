// B站：zeroroku 滚动 7 日涨粉榜 → 投稿列表（WBI 签名）→ view 数据 → AI 字幕，没有字幕就取音频转写。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function isoLocal(sec) {
  const d = new Date(sec * 1000);
  const off = -d.getTimezoneOffset();
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}

export async function board(ctx) {
  const { items } = await ctx.http.json('https://zeroroku.com/api/bilibili/fans-trend?period=7&direction=up');
  if (!items?.length) throw new Error('zeroroku 返回空榜');
  return {
    date: ymd(new Date()), // 实时滚动榜，结束日就是今天
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

export async function works(ctx, entry, board) {
  const { mid } = entry.ref;
  const data = await api(ctx, '/x/space/wbi/arc/search',
    { mid, ps: 30, pn: 1, order: 'pubdate', platform: 'web', web_location: 1550101, order_avoided: 'true', ...DM }, { signed: true });
  const vlist = data.list?.vlist ?? [];

  const end = new Date(`${board.date}T23:59:59`).getTime() / 1000;
  const start = new Date(`${board.date}T00:00:00`).getTime() / 1000 - ctx.opts.window * 86400;
  const inWindow = vlist.filter((v) => v.created >= start && v.created <= end);
  const notes = [];
  if (inWindow.length > MAX_WORKS) notes.push(`窗口内 ${inWindow.length}${inWindow.length === vlist.length ? '+' : ''} 条，只取最近 ${MAX_WORKS} 条`);

  const list = [];
  for (const v of inWindow.slice(0, MAX_WORKS)) {
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
      published_at: isoLocal(d?.pubdate ?? v.created),
      duration: d?.duration ?? null,
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
    creator: { id: mid, name: vlist[0]?.author ?? entry.name, url: `https://space.bilibili.com/${mid}`, followers: entry.followers },
    works: list,
    note: notes.join('；'),
  };
}

export async function copy(ctx, work) {
  if (!work.media) throw new Error('缺 cid，取不了字幕和音频');
  const { bvid, aid, cid } = work.media;

  // player/v2 的字幕列表常为空，dm/view 里能拿到 AI 字幕地址；人工中文字幕优先
  const subs = (await api(ctx, '/x/v2/dm/view', { type: 1, oid: cid, pid: aid })).subtitle?.subtitles ?? [];
  const sub = subs.find((s) => /^zh/.test(s.lan)) ?? subs.find((s) => s.lan === 'ai-zh') ?? subs[0];
  if (sub?.subtitle_url) {
    const body = await ctx.http.json(sub.subtitle_url.replace(/^(https?:)?\/\//, 'https://'));
    const text = (body.body ?? []).map((x) => x.content).join('\n').trim();
    if (text) return { source: 'subtitle', text };
  }

  const play = await api(ctx, '/x/player/playurl', { bvid, cid, fnval: 16, fourk: 0 });
  const audio = (play.dash?.audio ?? []).sort((a, b) => a.bandwidth - b.bandwidth)[0];
  const url = audio?.baseUrl ?? audio?.base_url ?? play.durl?.[0]?.url;
  if (!url) throw new Error('没有字幕，也取不到音频地址');
  ctx.log(`${bvid} 无字幕，转写音频（${work.duration ?? '?'} 秒）`);
  return { source: 'asr', text: await ctx.asr(url, { headers: { Referer: 'https://www.bilibili.com/' } }) };
}
