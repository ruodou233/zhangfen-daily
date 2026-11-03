// YouTube：viewstats「昨日涨粉」日榜（免登录；接口响应 AES 加密，令牌和密钥取自它的前端 JS），逐日数据找订阅数跳变日
// → 频道 RSS 最近 15 条上传（含 Shorts）→ 窗口内作品逐条 yt-dlp -J 取播放 / 点赞 / 评论和字幕列表
// → 文案 = 原语言字幕（人工 > 自动），没有字幕再下载音频转写；热评取「热门」排序前 20 条按赞数留 10 条。
// ZF_YT_REGION：频道所属国家 / 地区代码（TW、HK、SG、MY、CN、US…），逗号分隔则合并几榜按涨粉重排；不设为全球榜。
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const label = 'YouTube';

const VS = 'https://www.viewstats.com';
const VS_API = 'https://api.viewstats.com';
const MAX_WORKS = 10; // 窗口内作品只取最近 10 条去查详情
// viewstats 按太平洋时间切日：大频道每天 23:00（PT）左右快照，夏令时结束后快照的 UTC 时刻跟着晚了一小时；榜单缓存在 PT 零点过期
const TZ = 'America/Los_Angeles';
const REGION = (process.env.ZF_YT_REGION ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// yt-dlp：ZF_YTDLP 指定的可执行文件 → WorkBuddy 自带 Python 里较新的 yt_dlp → PATH 上的 yt-dlp → python3 -m yt_dlp。
// 只认带 --js-runtimes 的版本：YouTube 的 JS 挑战交给当前这个 Node 跑，用户不必另装 deno
const YTDLP = [
  process.env.ZF_YTDLP && [process.env.ZF_YTDLP],
  [path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/bin/python'), '-m', 'yt_dlp'],
  ['yt-dlp'],
  ['python3', '-m', 'yt_dlp'],
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function isoLocal(sec) {
  const d = new Date(sec * 1000);
  const off = -d.getTimezoneOffset();
  return `${ymd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
}
// tz 时区里某天某时刻对应的 Unix 秒
function zoned(day, time, tz) {
  const t = Date.parse(`${day}T${time}Z`);
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(t).map((x) => [x.type, +x.value]));
  return (2 * t - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)) / 1000;
}
const unescape = (s = '') =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// ---------- 榜单 ----------

// 前端把令牌和 AES-GCM 密钥 / IV 写死在某个 chunk 里，按页面引用顺序找到为止；chunk 名随发版变，所以每轮现取
let vsAuth;
const auth = (ctx) => (vsAuth ??= (async () => {
  const html = await ctx.http.text(`${VS}/top-list`);
  for (const chunk of new Set(html.match(/\/_next\/static\/chunks\/[^"'\s]+\.js/g) ?? [])) {
    const js = await ctx.http.text(VS + chunk);
    const token = js.match(/"Bearer "\.concat\("(\w+)"\)/)?.[1];
    const i = js.indexOf('Encryption environment');
    if (!token || i < 0) continue;
    // 两段 base64，解开是有符号字节数组：32 字节的是密钥，另一段是 IV
    const bytes = [...js.slice(Math.max(0, i - 1000), i).matchAll(/"([A-Za-z0-9+/]{16,}={0,2})"/g)].map(([, b]) => {
      try { return Uint8Array.from(JSON.parse(Buffer.from(b, 'base64').toString('utf8'))); } catch { return null; }
    }).filter(Boolean);
    const key = bytes.find((b) => b.length === 32);
    const iv = bytes.find((b) => b.length !== 32);
    if (key && iv) return { token, iv, key: await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']) };
  }
  throw new Error('viewstats 前端 JS 里没找到接口令牌和解密密钥，页面结构可能变了');
})());

async function vs(ctx, path, body, retry = true) {
  const { token, key, iv } = await auth(ctx);
  const res = await ctx.http.request(VS_API + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, Origin: VS, Referer: `${VS}/`, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
    timeout: 45_000,
  });
  // 没缓存的查询第一次常要十几秒，有时直接 500；隔几秒再请求一次多半已经算好
  if (res.status >= 500 && retry) { await sleep(3000); return vs(ctx, path, body, false); }
  if (!res.ok) throw new Error(`viewstats ${path.split('?')[0]} HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if ((res.headers.get('content-type') ?? '').includes('json')) return JSON.parse(Buffer.from(buf).toString('utf8'));
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf)));
}

// 筛选面板的三个开关（Show Made For Kids / Show Music Channels / Show Movies & Trailers）都关：只看创作者频道。
// 直接打开 /top-list 时三个开关默认就是关的；站内导航链接则是全开
const ranking = (ctx, country) => vs(ctx, '/rankings/channels', {
  interval: 'yesterday', sortBy: 'subs', made_for_kids: false, show_music: false, category_id: null, country, show_movies: false,
});
// 逐日数据：date 是快照所归的那天，subscriberCountDelta 是公开取整订阅数的日差。range 只接受 7 / 28 / 90 / 365
const daily = (ctx, id, range) =>
  vs(ctx, `/channels/${id}/stats?range=${range}&groupBy=daily&sortOrder=ASC&withRevenue=false&withEvents=false&withBreakdown=false&withToday=false`);

export async function board(ctx) {
  const lists = await Promise.all((REGION.length ? REGION : [null]).map((c) => ranking(ctx, c)));
  const seen = new Set();
  const rows = lists.flatMap((l) => l.data ?? [])
    .filter((r) => r.channel?.id && !seen.has(r.channel.id) && seen.add(r.channel.id))
    .sort((a, b) => b.subscriberCountDelta - a.subscriberCountDelta);
  if (!rows.length) throw new Error('viewstats 返回空榜');

  // 榜单接口不带日期（网页上的日期是浏览器按"今天减一"算的）。拿前几名的逐日数据对：
  // 订阅数和当日增量都对得上的那一天就是榜期。订阅数是公开的取整值，涨了才会变，所以同一组值只会落在一天。
  let date;
  let err;
  for (const r of rows.slice(0, 3)) {
    const data = await daily(ctx, r.channel.id, 7).then((x) => x.data, (e) => { err = e; });
    date = data?.findLast((d) => d.subscriberCount === r.channel.subscriberCount && d.subscriberCountDelta === r.subscriberCountDelta)?.date;
    if (date) break;
  }
  if (!date) throw new Error(`viewstats 榜单和前 3 名频道的逐日数据对不上，无法确认榜期${err ? `（${err.message}）` : ''}`);

  return {
    date,
    tz: TZ,
    period: REGION.length ? `日榜（${REGION.join('+')}）` : '日榜',
    url: `${VS}/top-list`,
    entries: rows.slice(0, ctx.opts.top).map((r, i) => ({
      rank: i + 1, name: r.channel.displayName, gain: r.subscriberCountDelta, followers: r.channel.subscriberCount,
      ref: { id: r.channel.id, handle: r.channel.handle },
    })),
  };
}

// ---------- yt-dlp ----------

let ytdlpCmd;
function ytdlp(args, timeout = 90_000) {
  ytdlpCmd ??= YTDLP.find(([cmd, ...pre]) => {
    try { return execFileSync(cmd, [...pre, '--help'], { encoding: 'utf8', timeout: 60_000 }).includes('--js-runtimes'); } catch { return false; }
  }) ?? new Error('找不到带 --js-runtimes 参数的 yt-dlp（pip install -U yt-dlp，或用 ZF_YTDLP 指定可执行文件）');
  if (ytdlpCmd instanceof Error) return Promise.reject(ytdlpCmd);
  const [cmd, ...pre] = ytdlpCmd;
  return new Promise((resolve, reject) => {
    execFile(cmd, [...pre, '--js-runtimes', `node:${process.execPath}`, '--no-warnings', '--no-playlist', ...args], { timeout, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      const last = stderr.trim().split('\n').filter((l) => /^ERROR/.test(l)).pop();
      reject(new Error(last?.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '') ?? (err.killed ? 'yt-dlp 超时' : err.message)));
    });
  });
}

const detail = async (url, extra = []) => JSON.parse(await ytdlp(['-J', '--skip-download', ...extra, url]));

// 原语言字幕：人工字幕 > 自动字幕（"-orig" 是没翻译过的原语言自动字幕）> 其他语言的人工字幕
function media(info) {
  const base = (k) => k.split('-')[0].toLowerCase();
  const manual = Object.keys(info.subtitles ?? {}).filter((k) => k !== 'live_chat');
  const auto = Object.keys(info.automatic_captions ?? {});
  const orig = auto.find((k) => k.endsWith('-orig'));
  const lang = info.language ?? orig?.replace(/-orig$/, '') ?? null;
  const human = lang && (manual.find((k) => k === lang) ?? manual.find((k) => base(k) === base(lang)));
  const pick = human ? ['subtitles', human]
    : orig || auto.includes(lang) ? ['automatic_captions', orig ?? lang]
      : manual[0] ? ['subtitles', manual[0]] : null;
  const url = pick && info[pick[0]][pick[1]].find((f) => f.ext === 'json3')?.url;
  return { lang, sub: url ? { lang: pick[1], kind: pick[0] === 'subtitles' ? '人工' : '自动', url } : null };
}

// ---------- 作品 ----------

// 一个频道同时最多查 3 条详情
async function mapLimit(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// 订阅数跳变日：公开订阅数是取整值，日差只在跨过取整档位那天出现。窗口内跳得最多的一天，并列取最早
async function peakDay(ctx, id, board) {
  const from = new Date(Date.parse(`${board.date}T00:00:00Z`) - ctx.opts.window * 86_400_000).toISOString().slice(0, 10);
  const { data } = await daily(ctx, id, [28, 90].find((r) => r >= ctx.opts.window + 3) ?? 365);
  let peak = null;
  for (const d of data ?? []) {
    if (d.date >= from && d.date <= board.date && d.subscriberCountDelta > (peak?.gain ?? 0)) peak = { date: d.date, gain: d.subscriberCountDelta };
  }
  return peak;
}

// 最近 15 条上传。RSS 发布时间精确到秒、带播放和点赞；RSS 偶尔整片 404，这时改读上传列表（UU 播放列表，长视频、Shorts、
// 直播回放混排，按发布时间倒序），它只有「x 天前」折算的近似日期，窗口留宽一点，精确时间等 -J 详情再核对
async function uploads(ctx, id) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  const res = await ctx.http.request(url).catch((e) => e);
  if (!(res instanceof Error) && res.ok) {
    const xml = await res.text();
    if (!xml.includes(`/channel/${id}"`)) throw new Error(`RSS 返回的不是频道 ${id}`);
    const tag = (s, t) => unescape(s.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`))?.[1] ?? '').trim();
    return {
      src: 'RSS',
      name: tag(xml.split('<entry>')[0], 'title'),
      feed: [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
        id: tag(e, 'yt:videoId'),
        url: e.match(/<link rel="alternate" href="([^"]+)"/)?.[1],
        title: tag(e, 'title'),
        published: Date.parse(tag(e, 'published')) / 1000,
        desc: tag(e, 'media:description'),
        likes: e.match(/<media:starRating count="(\d+)"/)?.[1],
        plays: e.match(/<media:statistics views="(\d+)"/)?.[1],
      })),
    };
  }
  const why = res instanceof Error ? res.message : `HTTP ${res.status}`;
  ctx.log(`频道 ${id} 的 RSS 失败（${why}），改读上传列表`);
  const pl = JSON.parse(await ytdlp(['--flat-playlist', '-J', '--playlist-end', '15', '--extractor-args', 'youtubetab:approximate_date',
    `https://www.youtube.com/playlist?list=UU${id.slice(2)}`]));
  if (pl.channel_id !== id) throw new Error(`上传列表不是频道 ${id} 的（RSS 也失败：${why}）`);
  return {
    src: '上传列表',
    why,
    name: pl.channel,
    feed: (pl.entries ?? []).map((e) => ({
      id: e.id, url: `https://www.youtube.com/watch?v=${e.id}`, title: e.title ?? '', published: e.timestamp ?? null, approx: true, desc: '', plays: e.view_count,
    })),
  };
}

export async function works(ctx, entry, board) {
  const { id } = entry.ref;
  // 逐日数据没缓存时要十几秒，和作品详情并行
  const peakP = peakDay(ctx, id, board).catch((e) => { ctx.log(`${entry.name} 订阅数跳变日取不到（${e.message}）`); return null; });
  const { src, why, name, feed } = await uploads(ctx, id);
  const exact = src === 'RSS';

  const end = zoned(board.date, '23:59:59', TZ);
  const start = zoned(board.date, '00:00:00', TZ) - ctx.opts.window * 86400;
  const inWindow = feed.filter((v) => (v.approx
    ? v.published == null || (v.published >= start - 7 * 86400 && v.published <= end + 2 * 86400) // 「x 周前」误差可到一周
    : v.published >= start && v.published <= end));
  const notes = exact ? [] : [`RSS 失败（${why}），改读上传列表前 ${feed.length} 条`];

  const toWork = async (v) => {
    let info = null;
    try {
      info = await detail(v.url);
    } catch (e) {
      if (/will begin|premieres? in/i.test(e.message)) return null; // 还没开播的直播 / 首映预告
      notes.push(`${v.id} 详情取不到（${e.message}）${v.approx ? '，发布时间无法核对，跳过' : '，用 RSS 数据'}`);
      if (v.approx) return null;
    }
    if (info?.live_status === 'is_upcoming') return null;
    if (v.approx && !(info.timestamp >= start && info.timestamp <= end)) return null;
    return {
      id: v.id,
      url: info?.media_type === 'short' ? `https://www.youtube.com/shorts/${v.id}` : v.url,
      title: info?.title ?? v.title,
      type: 'video',
      published_at: isoLocal(info?.timestamp ?? v.published),
      duration: info?.duration ?? null,
      metrics: {
        plays: info?.view_count ?? (v.plays ? +v.plays : null),
        likes: info?.like_count ?? (v.likes ? +v.likes : null),
        comments: info?.comment_count ?? null,
        collects: null,
        shares: null,
      },
      desc: info?.description ?? v.desc,
      media: info && media(info),
    };
  };
  // RSS 时间精确，只查最近 10 条；上传列表要逐条核对时间，候选全查
  const recent = mapLimit(exact ? inWindow.slice(0, MAX_WORKS) : inWindow, 3, toWork);

  // 最近 10 条，再加上跳变日及前 3 天发布的，让峰值规则有机会命中
  const peak = await peakP;
  const peakFrom = peak && zoned(peak.date, '00:00:00', TZ) - 3 * 86400;
  const peakTo = peak && zoned(peak.date, '23:59:59', TZ);
  const inPeak = (t) => !!peak && t >= peakFrom && t <= peakTo;
  const extra = exact ? inWindow.slice(MAX_WORKS).filter((v) => inPeak(v.published)) : [];
  let list = [...await recent, ...await mapLimit(extra, 3, toWork)].filter(Boolean);
  const total = exact ? inWindow.length : list.length;
  const more = exact ? extra.length : list.slice(MAX_WORKS).filter((w) => inPeak(Date.parse(w.published_at) / 1000)).length;
  if (!exact) list = [...list.slice(0, MAX_WORKS), ...list.slice(MAX_WORKS).filter((w) => inPeak(Date.parse(w.published_at) / 1000))];

  const known = feed.filter((v) => v.published != null).map((v) => v.published);
  const partial = known.length && Math.min(...known) > start; // 列表没覆盖到窗口起点
  if (known.length && !known.some((t) => t <= end)) notes.push(`${src}最近 ${feed.length} 条都发在榜期之后（更新太勤），窗口内作品没取到`);
  else if (total > MAX_WORKS) {
    notes.push(`窗口内 ${total}${partial ? '+' : ''} 条，只取最近 ${MAX_WORKS} 条${more ? `和订阅数跳变日前后 ${more} 条` : ''}`);
  } else if (partial) notes.push(`${src}只有最近 ${feed.length} 条，窗口内至少 ${total} 条`);
  ctx.log(`${entry.name}：${src} ${feed.length} 条，窗口内 ${total} 条`);

  return {
    creator: { id, name: name || entry.name, url: `https://www.youtube.com/channel/${id}`, followers: entry.followers },
    works: list,
    note: notes.join('；'),
    peak,
  };
}

// ---------- 文案 ----------

// json3：events[].segs[].utf8；去掉排版用的零宽字符，自动字幕里单独的换行事件、相邻重复行去掉
function json3Text(body) {
  const lines = [];
  for (const e of body.events ?? []) {
    const t = (e.segs ?? []).map((s) => s.utf8 ?? '').join('').replace(/[\u200b-\u200f\u2060\ufeff]/g, '').replace(/\s+/g, ' ').trim();
    if (t && t !== lines.at(-1)) lines.push(t);
  }
  return lines.join('\n');
}

export async function copy(ctx, work) {
  const c = await transcript(ctx, work, work.media ?? media(await detail(work.url)));
  try {
    // 「热门」排序第一页，置顶的（多是作者自己的）不算；赞数是页面上的取整值
    const info = await detail(work.url, ['--write-comments', '--extractor-args', 'youtube:comment_sort=top;max_comments=20,20,0,0']);
    c.comments = (info.comments ?? []).filter((x) => !x.is_pinned).map((x) => ({ text: x.text ?? '', likes: x.like_count ?? 0 }))
      .sort((x, y) => y.likes - x.likes).slice(0, 10);
  } catch (e) {
    ctx.log(`${work.id} 热评取不到（${e.message}）`);
  }
  return c;
}

async function transcript(ctx, work, m) {
  if (m.sub) {
    const text = json3Text(await ctx.http.json(m.sub.url, { timeout: 45_000 })); // timedtext 偶尔卡十几秒
    if (text) return { source: 'subtitle', text };
  }
  // 转写语言用视频标注的；没标注时标题或简介有汉字就按中文（YouTube 一般不给中文视频生成自动字幕），否则自动识别
  const language = m.lang ?? (/\p{Script=Han}/u.test(`${work.title} ${work.desc}`) ? 'zh' : undefined);
  // 直接拉音频流会被限速到约 1 倍速，交给 yt-dlp 分块下载到临时目录再转写
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zf-youtube-'));
  try {
    ctx.log(`${work.id} 无字幕，下载音频转写（${language ?? '自动识别语言'}，${work.duration ?? '?'} 秒）`);
    await ytdlp(['-q', '-f', 'ba[ext=m4a]/ba', '-o', path.join(dir, 'audio.%(ext)s'), work.url], 600_000);
    const file = fs.readdirSync(dir).find((f) => f.startsWith('audio.'));
    if (!file) throw new Error('yt-dlp 没有下载到音频');
    return { source: 'asr', text: await ctx.asr(path.join(dir, file), { language }) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
