// 抖音：飞瓜日涨粉榜（免登录 HTTP）→ 飞瓜详情页拿 uid 和逐日涨粉 → 换成 sec_uid（缓存 → 直播用户接口 → 浏览器搜抖音号）
// → 浏览器打开创作者主页读作品列表（aweme/post 接口）→ 文案 = 简介 + 视频转写。
import fs from 'node:fs';
import path from 'node:path';

export const label = '抖音';

const FG = 'https://dy3.feigua.cn';
const DAY = 86_400_000;
const CST = 8 * 3_600_000;

const rankUrl = (ymd) => `${FG}/rank/fans/0/day/${ymd}.html`;
const unescape = (s) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .trim();
// '71.6w' → 716000；'-' 等认不出的给 null
const num = (s) => {
  const m = String(s).trim().match(/^([\d.]+)\s*(w|万|亿)?$/i);
  return m ? Math.round(parseFloat(m[1]) * ({ w: 1e4, 万: 1e4, 亿: 1e8 }[m[2]?.toLowerCase()] ?? 1)) : null;
};
// 北京时间的 ISO 串，便于直接按前 10 位取日期
const cstISO = (ms) => new Date(ms + CST).toISOString().replace('Z', '+08:00');

// 飞瓜对未发布的日期不报错，而是把最新一期的数据套上所请求日期返回。
// 但页面的日期下拉 #dateSel 只列已发布的期次（第一项最新），真实那一期在列表里会带 class="active"。
function periods(html) {
  const ul = html.match(/id="dateSel"[\s\S]*?<\/ul>/)?.[0] ?? '';
  return [...ul.matchAll(/<li([^>]*)>\s*<a href="\/rank\/fans\/0\/day\/(\d{8})\.html"/g)]
    .map(([, attr, ymd]) => ({ ymd, active: /active/.test(attr) }));
}

export async function board(ctx) {
  // 先猜昨天（北京时间）；没发布就跟着下拉列表的第一项走
  const guess = cstISO(Date.now() - DAY).slice(0, 10).replaceAll('-', '');
  let html = await ctx.http.text(rankUrl(guess));
  const latest = periods(html)[0]?.ymd;
  if (!latest) throw new Error('飞瓜榜单页里没找到期次列表，页面结构可能变了');
  if (latest !== guess) {
    ctx.log(`飞瓜 ${guess} 期还没发布，改取最新一期 ${latest}`);
    html = await ctx.http.text(rankUrl(latest));
  }
  if (!periods(html).find((p) => p.active && p.ymd === latest)) throw new Error(`飞瓜 ${latest} 期页面没有标记为当前期，无法确认榜期`);

  const tbody = html.match(/<tbody id="js-blogger-container">([\s\S]*?)<\/tbody>/)?.[1] ?? '';
  const entries = [];
  for (const [, tr] of tbody.matchAll(/<tr>([\s\S]*?)<\/tr>/g)) {
    const rank = tr.match(/class="rank[^"]*">\s*(\d+)/)?.[1];
    const name = tr.match(/person-publicnum[\s\S]*?<span>([\s\S]*?)<\/span>/)?.[1];
    const detail = tr.match(/href="(\/bloggeropen\/[0-9A-Fa-f]+)"/)?.[1];
    const [gain, followers] = [...tr.matchAll(/<td>([^<]*)<\/td>/g)].map((m) => m[1]);
    if (rank && name && detail) entries.push({ rank: +rank, name: unescape(name), gain: num(gain), followers: num(followers), ref: { detail: FG + detail } });
  }
  if (!entries.length) throw new Error(`飞瓜 ${latest} 期榜单没解析出条目`);
  return {
    date: `${latest.slice(0, 4)}-${latest.slice(4, 6)}-${latest.slice(6)}`,
    period: '日榜',
    url: rankUrl(latest),
    entries: entries.slice(0, ctx.opts.top),
  };
}

// 飞瓜详情页：抖音 uid、抖音号（未设置时是短 id）、昵称、近 90 天逐日涨粉（x 是北京时间零点）；没有 sec_uid
async function feiguaProfile(ctx, url) {
  const html = await ctx.http.text(url);
  const pick = (re) => html.match(re)?.[1];
  const uid = pick(/data-uid="(\d+)"/) ?? pick(/iesdouyin\.com\/share\/user\/(\d+)/);
  if (!uid) throw new Error(`飞瓜详情页没有抖音 uid：${url}`);
  let fansInc = [];
  try { fansInc = JSON.parse(pick(/var fansInc90 = (\[[^\]]*\])/)); } catch {}
  return { uid, douyinId: pick(/抖音号：<span>([^<]+)<\/span>/)?.trim(), nickname: unescape(pick(/data-nickname="([^"]*)"/) ?? ''), fansInc };
}

function peakDay(fansInc, board, window) {
  const end = Date.parse(`${board.date}T00:00:00+08:00`);
  let peak = null;
  for (const { x, y } of fansInc) {
    if (x >= end - window * DAY && x <= end && !(peak?.gain >= y)) peak = { date: cstISO(x).slice(0, 10), gain: y };
  }
  return peak;
}

const SEARCH = /aweme\/v1\/web\/discover\/search/;
const POST = /aweme\/v1\/web\/aweme\/post/;

// uid → sec_uid。直播的用户接口按 uid 直接给 sec_uid，纯 HTTP、免登录；搜索只作后备（搜多了会触发验证码）。
// 结果按 uid 缓存在 <out>/cache/douyin_sec_uid.json，同一作者再上榜就不用再找。
async function resolveSecUid(ctx, fg, entry) {
  const file = path.join(ctx.opts.out, 'cache', 'douyin_sec_uid.json');
  const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  if (cache[fg.uid]) return { secUid: cache[fg.uid] };

  let found;
  try {
    const { data } = await ctx.http.json(`https://live.douyin.com/webcast/user/?aid=6383&target_uid=${fg.uid}`);
    if (data?.id_str === fg.uid && data.sec_uid) found = { secUid: data.sec_uid, followers: data.follow_info?.follower_count };
    else ctx.log(`直播用户接口没有 uid=${fg.uid} 的 sec_uid，改用搜索`);
  } catch (e) {
    ctx.log(`直播用户接口失败（${e.message}），改用搜索`);
  }
  found ??= await searchUser(ctx, fg, entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...cache, [fg.uid]: found.secUid }, null, 1));
  return found;
}

// 浏览器里按抖音号（退而按昵称）搜用户，只认 uid 完全一致的那个。失败时说清是没登录、验证码还是没搜到。
async function searchUser(ctx, fg, entry) {
  const session = await ctx.browser();
  if (!(await session.cookieHeader('www.douyin.com')).includes('sessionid=')) {
    throw new Error('抖音搜索需要登录，日常 Chrome 里抖音没登录（登录 douyin.com 后重跑）');
  }
  for (const q of [fg.douyinId, fg.nickname || entry.name].filter(Boolean)) {
    const page = await session.open(`https://www.douyin.com/search/${encodeURIComponent(q)}?type=user`, { capture: [SEARCH], waitMs: 0 });
    try {
      const res = await page.waitFor(() => page.responses.find((r) => SEARCH.test(r.url)), 20_000).catch(() => null);
      const body = res?.body && typeof res.body === 'object' ? res.body : null;
      const nil = body?.search_nil_info?.search_nil_type ?? '';
      if (body && !body.status_code && !/verify/.test(nil)) {
        const user = body.user_list?.map((u) => u.user_info).find((u) => String(u?.uid) === fg.uid);
        if (user?.sec_uid) return { secUid: user.sec_uid, followers: user.follower_count };
        continue;
      }
      // 被拦下了：分清是验证码还是别的
      const captcha = /verify/.test(nil) || await page.eval(`[...document.querySelectorAll('[id*=captcha],[class*=captcha],iframe')]
        .some((e) => !/nocaptcha/.test(e.id + (e.src || '')) && /captcha|verify/i.test(e.id + e.className + (e.src || '')))`).catch(() => false);
      if (captcha) throw new Error('抖音搜索弹了验证码（搜索风控），在日常 Chrome 里打开抖音搜一次、过掉验证后重跑');
      if (!res) throw new Error(`抖音搜索“${q}”20 秒没有响应`);
      throw new Error(`抖音搜索被拦截（${body ? `status_code=${body.status_code} ${body.status_msg ?? ''}`.trim() : '接口返回空响应'}），多半是搜索风控，隔几小时再跑`);
    } finally {
      await page.close();
    }
  }
  throw new Error(`抖音搜索抖音号 ${fg.douyinId ?? '（无）'} 和昵称都没有 uid=${fg.uid} 的账号`);
}

export async function works(ctx, entry, board) {
  const fg = await feiguaProfile(ctx, entry.ref.detail);
  const { secUid, followers } = await resolveSecUid(ctx, fg, entry);

  // 作品列表按发布时间倒序（置顶的排最前），首屏会自己连着加载两三页。
  // 发得勤的号第一页可能全是榜期之后的作品，所以沿用首屏自己加载的后续页，碰到榜期就停，最多 3 页。
  const url = `https://www.douyin.com/user/${secUid}`;
  const end = Date.parse(`${board.date}T23:59:59.999+08:00`);
  const start = end + 1 - (ctx.opts.window + 1) * DAY;
  const session = await ctx.browser();
  const page = await session.open(url, { capture: [POST], waitMs: 0 });
  const list = [];
  let used = 0;
  let more = false;
  try {
    const posts = () => page.responses.filter((r) => r.body && typeof r.body === 'object');
    for (let i = 0; i < 3; i++) {
      if (i && !posts()[i]) await page.eval('window.scrollTo(0, document.documentElement.scrollHeight)').catch(() => {});
      const res = await page.waitFor(() => posts()[i], i ? 10_000 : 20_000).catch(() => null);
      if (!i && !res) throw new Error('主页没有返回作品列表（可能是私密账号或出了验证码）');
      if (!i && res.body.status_code !== 0) throw new Error(`作品接口返回 status_code=${res.body.status_code}`);
      if (res?.body.status_code !== 0) break;
      list.push(...(res.body.aweme_list ?? []));
      used++;
      more = !!res.body.has_more;
      const oldest = Math.min(...list.filter((a) => !a.is_top).map((a) => a.create_time * 1000));
      if (!res.body.has_more || oldest <= end) break;
    }
  } finally {
    await page.close();
  }

  const inWindow = list.filter((a) => a.create_time * 1000 >= start && a.create_time * 1000 <= end);
  const own = list.find((a) => String(a.author?.uid) === fg.uid)?.author; // 共创作品的作者可能是别的号
  const earliest = Math.min(...list.filter((a) => !a.is_top).map((a) => a.create_time * 1000));
  ctx.log(`${entry.name}：主页取了 ${used} 页 ${list.length} 条，窗口内 ${inWindow.length} 条`);
  return {
    creator: { id: fg.uid, name: own?.nickname || fg.nickname || entry.name, url, followers: followers ?? entry.followers },
    works: inWindow.map(toWork),
    note: more && earliest > start ? `主页只取了 ${used} 页，窗口内至少 ${inWindow.length} 条` : '',
    peak: peakDay(fg.fansInc, board, ctx.opts.window),
  };
}

function toWork(a) {
  const st = a.statistics ?? {};
  const v = a.video ?? {};
  // 图文、文章的 video 字段里只有配乐，时长为 0
  const isNote = !(v.duration > 0);
  // 转写只要声音：有单独音轨（dash 视频）就用最小的音轨，否则用码率最低的 mp4（dash 档没有声音）
  const byRate = (key) => (x, y) => key(x) - key(y);
  const audio = [...(v.bit_rate_audio ?? [])].sort(byRate((x) => x.audio_meta?.bitrate))[0]?.audio_meta?.url_list?.main_url;
  const mp4 = (v.bit_rate ?? []).filter((b) => b.format !== 'dash').sort(byRate((b) => b.bit_rate))[0]?.play_addr?.url_list?.[0];
  const play = audio ?? mp4 ?? v.play_addr?.url_list?.[0];
  const desc = (a.desc || a.preview_title || '').trim();
  return {
    id: a.aweme_id,
    url: `https://www.douyin.com/${isNote ? 'note' : 'video'}/${a.aweme_id}`,
    title: a.item_title || desc.split('\n')[0].slice(0, 60),
    type: isNote ? 'note' : 'video',
    published_at: cstISO(a.create_time * 1000),
    // 网页端拿不到别人作品的播放数（恒为 0），记为 null
    metrics: { plays: st.play_count || null, likes: st.digg_count ?? null, comments: st.comment_count ?? null, collects: st.collect_count ?? null, shares: st.share_count ?? null },
    desc,
    media: !isNote && play ? { url: play, headers: { Referer: 'https://www.douyin.com/' }, duration: v.duration / 1000 } : null,
  };
}

export async function copy(ctx, work) {
  if (!work.media?.url) {
    if (!work.desc) throw new Error('图文作品没有文字说明');
    return { source: 'text', text: work.desc };
  }
  // asr 没有人声时返回空串，这时只用简介
  const speech = (await ctx.asr(work.media.url, { headers: work.media.headers, language: 'zh' })).trim();
  if (!speech && !work.desc) throw new Error('没有简介，视频里也没有人声');
  if (!speech) return { source: 'text', text: work.desc };
  if (!work.desc) return { source: 'asr', text: speech };
  return { source: 'text+asr', text: `${work.desc}\n\n${speech}` };
}
