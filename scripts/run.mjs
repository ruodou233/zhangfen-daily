#!/usr/bin/env node
// 涨粉榜日报：榜单 → 作者 → 榜期附近作品 → 代表作文案 → report.md / data.json
// node scripts/run.mjs --out <dir> [--platforms bilibili,xhs,youtube,douyin,x,kuaishou,channels] [--concurrency 2]
//                      [--focus 教育母婴,AI科技,/path/采集清单.json] [--focus-top 5] [--no-site]
//                      [--top 10] [--copy 2] [--window 14] [--budget-min 60] [--chrome-profile <Chrome 用户数据目录>] [--python <解释器>]
// 平台按列表顺序进 --concurrency 个并发槽；默认顺序把纯 HTTP 的平台和浏览器重的平台交错开。转写全局排队，一次一个。
// 额外专精（lib/focus.mjs）= 分类涨粉榜 + 关注账号，和该平台的全站榜在同一个槽里接着跑：全站榜 → 各专精的分类榜 → 各专精的关注账号。
// 同一作者同一天在几处出现只采一次。跑完调用 curate.mjs 更新精选库，日报里列出当天新入选的；来自采集清单的专精另写竞对数据包。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as http from './lib/http.mjs';
import { launchBrowser, closeAllBrowsers } from './lib/browser.mjs';
import { createAsr, killAsr } from './lib/asr.mjs';
import { writeData, writeReport } from './lib/report.mjs';
import { loadFocus, writePack } from './lib/focus.mjs';
import { curate, DEFAULTS as GATE, wordCount } from './curate.mjs';

const { values: a } = parseArgs({
  options: {
    out: { type: 'string' },
    platforms: { type: 'string', default: 'bilibili,xhs,youtube,douyin,x,kuaishou,channels' },
    concurrency: { type: 'string', default: '2' },
    focus: { type: 'string' },
    'focus-top': { type: 'string', default: '5' },
    'no-site': { type: 'boolean', default: false },
    top: { type: 'string', default: '10' },
    copy: { type: 'string', default: '2' },
    window: { type: 'string', default: '14' },
    'budget-min': { type: 'string', default: '60' },
    'chrome-profile': { type: 'string' },
    python: { type: 'string' },
  },
});
if (!a.out || (a['no-site'] && !a.focus)) {
  console.error('用法：node scripts/run.mjs --out <目录> [--platforms bilibili,xhs,youtube,douyin,x,kuaishou,channels] [--concurrency 2] [--focus 教育母婴,AI科技] [--focus-top 5] [--no-site] [--top 10] [--copy 2] [--window 14] [--budget-min 60]');
  process.exit(2);
}
const opts = {
  out: path.resolve(a.out),
  platforms: a.platforms.split(',').map((s) => s.trim()).filter(Boolean),
  concurrency: Math.max(1, +a.concurrency || 1),
  focus: (a.focus ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  focusTop: +a['focus-top'],
  site: !a['no-site'],
  top: +a.top,
  copy: +a.copy,
  window: +a.window,
  budget_min: +a['budget-min'],
  chromeProfile: a['chrome-profile'],
  python: a.python,
};

const DAY = 86_400_000;
const pad = (n) => String(n).padStart(2, '0');
const now = () => new Date();
// 日期一律按榜单所在时区取（board.tz，默认北京时间），不看运行机器的时区
const TZ = 'Asia/Shanghai';
const dayIn = (ms, tz = TZ) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const dayNo = (date) => Date.parse(`${date}T00:00:00Z`) / DAY; // YYYY-MM-DD → 第几天，做日期加减
const shift = (date, n) => new Date((dayNo(date) + n) * DAY).toISOString().slice(0, 10);
const log = (tag, msg) => {
  const d = now();
  console.error(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] [${tag}] ${msg}`);
};
const safeName = (id) => String(id).replace(/[^\w.-]/g, '_');

// 上次被强杀留下的临时目录：属主进程已不在就连同进程一起清掉
function cleanStale() {
  const tmp = os.tmpdir();
  for (const name of fs.readdirSync(tmp)) {
    const m = name.match(/^zhangfen-chrome-(\d+)-/);
    if (!m) continue;
    try { process.kill(+m[1], 0); continue; } catch {}
    const dir = path.join(tmp, name);
    try { execFileSync('pkill', ['-9', '-f', dir], { stdio: 'ignore' }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
    log('启动', `清掉残留 ${name}`);
  }
}

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log('退出', `收到 ${sig}，关闭 Chrome 和转写进程`);
    killAsr();
    await closeAllBrowsers();
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

// 文案缓存：头部几行元信息，空行后是正文，末尾可有「## 热评」一节
const HOT = '\n## 热评\n';
function readCopy(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const i = raw.indexOf('\n\n');
  const head = raw.slice(0, i);
  const language = head.match(/^语言：(.+)$/m)?.[1];
  return { source: head.match(/^来源：(.+)$/m)?.[1] ?? 'text', chars: raw.slice(i + 2).split(HOT)[0].trim().length, ...(language ? { language } : {}) };
}

function writeCopy(file, work, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = [`标题：${(work.title || '').replace(/\s+/g, ' ')}`, `链接：${work.url}`, `发布：${work.published_at ?? ''}`, `来源：${c.source}`];
  if (c.language) head.push(`语言：${c.language}`);
  const hot = (c.comments ?? []).filter((x) => x.text?.trim()).map((x) => `- ${x.text.replace(/\s+/g, ' ').trim()}（赞 ${x.likes ?? '—'}）`);
  fs.writeFileSync(file, `${head.join('\n')}\n\n${c.text}\n${hot.length ? `${HOT}\n${hot.join('\n')}\n` : ''}`);
}

const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1) || (y.metrics?.plays ?? -1) - (x.metrics?.plays ?? -1);
const daysBefore = (date, iso, tz) => dayNo(date) - dayNo(dayIn(Date.parse(iso), tz));

// 取文案前能看出的精选门槛：0 = 达到（视频够长、图文正文够长），1 = 还不知道（时长或正文没拿到），2 = 没达到
function fit(w, platform) {
  if (w.type === 'note') {
    if (w.desc == null) return 1;
    return wordCount(w.desc.replace(/#[^\s#]+#?/g, '')) >= (platform === 'x' ? GATE.minTweet : GATE.minNote) ? 0 : 2;
  }
  const d = w.duration ?? w.media?.duration;
  return d == null ? 1 : d >= GATE.minVideoSec ? 0 : 2;
}

// 代表作：有峰值日时先给「峰值日及前 3 天内发布、点赞最高」的一条；其余名额先给过门槛的，再给不知道的，各自按点赞
function pickReps(works, peak, n, tz, platform) {
  const sorted = [...works].sort((x, y) => fit(x, platform) - fit(y, platform) || byLikes(x, y));
  const near = peak && [...works].sort(byLikes).find((w) => { const d = daysBefore(peak.date, w.published_at, tz); return d >= 0 && d <= 3; });
  const picks = near && n > 0 ? [Object.assign(near, { pick: 'peak' })] : [];
  for (const w of sorted) if (picks.length < n && !picks.includes(w)) picks.push(Object.assign(w, { pick: 'likes' }));
  return picks;
}

// 在榜天数：和前一天的 data.json 按作者 ID（没有就按名字）比对；前一天没有日报就都从 1 算。
// 同一期榜没更新（榜期和昨天一样）时沿用昨天的天数，不加 1
function markStreaks(result) {
  const yesterday = shift(result.date, -1);
  const file = path.join(opts.out, yesterday, 'data.json');
  const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  result.prev_date = prev ? yesterday : null;
  for (const p of result.platforms) {
    const q = prev?.platforms.find((x) => x.name === p.name && (x.focus ?? x.vertical ?? null) === p.focus && (x.category ?? null) === p.category);
    const same = !!p.board && q?.board?.date === p.board.date;
    if (same) p.board.unchanged = true;
    for (const e of p.entries) {
      const o = q?.entries.find((x) => (e.creator?.id != null && String(x.creator?.id) === String(e.creator.id)) || x.name === e.name);
      e.streak = o ? (o.streak ?? 1) + (same ? 0 : 1) : 1;
    }
  }
}

// 同一平台里认作者：榜单给的稳定 ID（mid、飞瓜详情页、千瓜头像、频道 ID……），没有就用名字。
// 采过之后再按 creator.id 和主页链接最后一段登记，这样关注账号（主页链接给的 sec_uid / user_id / mid）也能认出是同一个人
const whoKey = (entry) => { const r = entry.ref ?? {}; return `ref:${r.mid ?? r.detail ?? r.avatar ?? r.id ?? r.userId ?? r.handle ?? entry.name}`; };
const authorKeys = (e) => [
  e.creator?.id != null && `id:${e.creator.id}`,
  e.creator?.url && `id:${e.creator.url.split(/[?#]/)[0].replace(/\/$/, '').split('/').pop()}`,
].filter(Boolean);
function remember(seen, e, where, keys = []) { for (const k of [...keys, ...authorKeys(e)]) if (!seen.has(k)) seen.set(k, { e, where }); }
function reuse(e, first) {
  const { creator, works, peak, error } = first.e;
  Object.assign(e, { creator, works, peak, error, same_as: `${first.where}${first.e.rank ? ` #${first.e.rank}` : ''}` });
}

// 采一位作者：作品列表 →（需要时）补详情 → 代表作 → 文案。e 是榜上条目或关注账号，结果写回 e
async function collect(mod, ctx, e, entry, board, platform, tz, result, who) {
  try {
    const w = await mod.works(ctx, entry, board);
    Object.assign(e, { creator: w.creator, works: w.works ?? [], note: w.note || undefined, peak: w.peak ?? undefined });
  } catch (err) {
    e.error = err.message;
    ctx.log(`${who} 失败：${err.message}`);
    return;
  }
  ctx.log(`${who}：窗口内 ${e.works.length} 条`);
  // 列表里没有时长的平台（小红书、快手）：只给点赞前 K 条补详情，再按门槛选代表作
  if (mod.enrich) {
    const k = mod.ENRICH_TOP ?? ctx.opts.copy + 3;
    try {
      await mod.enrich(ctx, [...e.works].sort(byLikes).slice(0, k));
    } catch (err) {
      e.error = err.message; // 风控之类，整位作者停下
      ctx.log(`${who} 失败：${err.message}`);
      return;
    }
  }
  for (const w of pickReps(e.works, e.peak, ctx.opts.copy, tz, platform)) {
    w.representative = true;
    const file = path.join('copy', platform, `${safeName(w.id)}.txt`);
    const abs = path.join(ctx.opts.out, file);
    const cached = readCopy(abs);
    if (cached) { w.copy = { ...cached, file, cached: true }; continue; }
    if (Date.now() > ctx.deadline) { w.copy_error = '预算用完，跳过'; result.budget_exhausted = true; continue; }
    try {
      let language; // 转写识别出的语言，精选库里标出来，方便发现识别错
      const c = await mod.copy({ ...ctx, asr: (input, o = {}) => ctx.asr(input, { ...o, onLanguage: (l) => { language = l; } }) }, w);
      c.text = c.text?.trim() ?? ''; // 空文案（未转出有效语音、正文为空）也缓存：同一模型重转结果一样
      c.language = language;
      writeCopy(abs, w, c);
      w.copy = { source: c.source, file, chars: c.text.length, ...(language ? { language } : {}) };
      ctx.log(`  ${w.id} 文案 ${w.copy.chars} 字（${c.source}）`);
    } catch (err) {
      w.copy_error = err.message;
      ctx.log(`  ${w.id} 文案失败：${err.message}`);
    }
  }
}

// p 是一个榜（全站榜或某个专精的分类榜）；seen 在同一平台的各个榜和关注账号之间共用，同一作者只采一次
async function runBoard(mod, ctx, p, result, seen) {
  const b = await mod.board(ctx, p.category ? { category: p.category } : undefined);
  p.board = { date: b.date, period: b.period, url: b.url, tz: b.tz ?? TZ };
  const where = p.focus ? `${p.focus}·${p.category}榜` : '全站榜';
  ctx.log(`${where} 榜期 ${b.date}（${b.period}），${b.entries.length} 位`);
  for (const entry of b.entries) {
    const e = { ...entry };
    p.entries.push(e);
    const first = seen.get(whoKey(entry));
    if (first) {
      reuse(e, first);
      ctx.log(`${where} #${entry.rank} ${entry.name}：已在${first.where}采过`);
      continue;
    }
    if (Date.now() > ctx.deadline) { e.error = '预算用完，跳过'; result.budget_exhausted = true; continue; }
    seen.set(whoKey(entry), { e, where });
    await collect(mod, ctx, e, entry, b, p.name, p.board.tz, result, `#${entry.rank} ${entry.name}`);
    remember(seen, e, where);
  }
}

// 关注账号：按主页链接取作品，逻辑和榜单作者一致；没有榜期，作品窗口按今天算
async function runAccount(mod, ctx, x, result, seen, day) {
  const where = `${x.focus}·关注`;
  if (Date.now() > ctx.deadline) { x.error = '预算用完，跳过'; result.budget_exhausted = true; return; }
  let ref;
  try {
    ref = await mod.parseUrl(ctx, x.input.url);
  } catch (err) {
    x.error = err.message;
    ctx.log(`${where} ${x.input.name} 失败：${err.message}`);
    return;
  }
  const first = Object.values(ref).map((v) => seen.get(`id:${v}`)).find(Boolean);
  if (first) {
    reuse(x, first);
    ctx.log(`${where} ${x.input.name}：已在${first.where}采过`);
    return;
  }
  await collect(mod, ctx, x, { name: x.input.name, ref, followers: null }, { date: day }, x.platform, TZ, result, `${where} ${x.input.name}`);
  remember(seen, x, where, Object.values(ref).map((v) => `id:${v}`));
}

async function main() {
  const started = Date.now();
  const day = dayIn(Date.now()); // 运行日按北京时间，决定输出目录
  cleanStale();
  const deadline = started + opts.budget_min * 60_000;
  const asr = createAsr({ python: opts.python, log: (m) => log('转写', m) });
  const result = {
    date: day,
    generated_at: now().toISOString(),
    opts: { platforms: opts.platforms, concurrency: opts.concurrency, focus: opts.focus, focus_top: opts.focusTop, site: opts.site, top: opts.top, copy: opts.copy, window: opts.window, budget_min: opts.budget_min },
    budget_exhausted: false,
    platforms: [],
  };

  // 一个平台一个槽、一个浏览器会话（懒启动，平台的全部榜跑完就关）；asr 全局共用、内部排队
  async function runOne(name, boards, accounts) {
    let mod;
    try {
      mod = await import(`./platforms/${name}.mjs`);
    } catch (e) {
      const error = `模块未就绪（${e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(`${name}.mjs`) ? '文件不存在' : e.message}）`;
      for (const p of boards) Object.assign(p, { status: 'unavailable', error });
      for (const x of accounts) x.skipped = '这个平台暂不支持自动采集';
      log(name, error);
      return;
    }
    let session;
    const label = mod.label ?? name;
    const ctx = {
      opts, deadline, http,
      log: (m) => log(label, m),
      asr: (input, o = {}) => asr(input, { ...o, log: (m) => log(label, `转写：${m}`) }),
      browser: () => (session ??= launchBrowser({ chromeProfile: opts.chromeProfile })),
    };
    const seen = new Map();
    try {
      for (const p of boards) {
        p.label = label;
        if (p.category && !(p.category in (mod.CATEGORIES ?? {}))) {
          Object.assign(p, { status: 'failed', error: `${label}没有「${p.category}」分类${mod.CATEGORIES ? `（可选：${Object.keys(mod.CATEGORIES).join('、')}）` : ''}` });
          continue;
        }
        if (Date.now() > deadline) {
          Object.assign(p, { status: 'skipped', error: '预算用完，未运行' });
          result.budget_exhausted = true;
          continue;
        }
        const t = Date.now();
        try {
          await runBoard(mod, { ...ctx, opts: p.focus ? { ...opts, top: p.top } : opts }, p, result, seen);
        } catch (e) {
          Object.assign(p, { status: 'failed', error: e.message });
          log(label, `${p.category ?? '全站'}榜失败：${e.message}`);
        }
        p.elapsed_s = Math.round((Date.now() - t) / 1000);
      }
      // 关注账号放在全部榜之后：榜上采过的人这里直接认出来，不再采
      for (const x of accounts) {
        x.label = label;
        if (!mod.parseUrl) { x.skipped = '这个平台暂不支持自动采集'; continue; }
        await runAccount(mod, ctx, x, result, seen, day);
      }
    } finally {
      if (session) await (await session.catch(() => null))?.close();
    }
  }

  // 榜：全站各平台在前，专精的分类榜在后（data.json 和日报都按这个顺序）；关注账号单列在 result.focus[].accounts
  const board = (name, focus = null, category = null, top) => ({ name, label: name, focus, category, top, status: 'ok', entries: [] });
  result.platforms = opts.site ? opts.platforms.map((name) => board(name)) : [];
  result.focus = opts.focus.map((spec) => {
    const f = loadFocus(spec, opts.out);
    if (f.error) log('专精', f.error);
    const top = f.top ?? opts.focusTop;
    for (const key of f.boards) {
      const [n, c] = key.split(':');
      const p = board(n, f.name, c, top);
      if (!opts.platforms.includes(n)) Object.assign(p, { status: 'skipped', error: `${n} 不在 --platforms 里` });
      result.platforms.push(p);
    }
    const accounts = f.accounts.map((x) => ({
      focus: f.name, platform: x.platform, label: x.platform, ref: x.ref, input: { name: x.name, url: x.url },
      ...(!x.url ? { skipped: '没有主页链接' }
        : !fs.existsSync(new URL(`./platforms/${x.platform}.mjs`, import.meta.url)) ? { skipped: '这个平台暂不支持自动采集' }
        : !opts.platforms.includes(x.platform) ? { skipped: `${x.platform} 不在 --platforms 里` } : {}),
    }));
    return { name: f.name, file: f.file ?? null, watchlist: !!f.watchlist, ...(f.error ? { error: f.error } : {}), accounts };
  });
  const allAccounts = result.focus.flatMap((f) => f.accounts);
  const jobs = opts.platforms
    .map((name) => [name, result.platforms.filter((p) => p.name === name && p.status === 'ok'), allAccounts.filter((x) => x.platform === name && !x.skipped)])
    .filter(([, b, x]) => b.length || x.length);
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, async () => {
    for (let j; (j = jobs.shift());) await runOne(...j);
  }));

  markStreaks(result);
  // 有的模块只把时长放在 media 里（media 不落盘），提到作品上给精选用
  for (const e of [...result.platforms.flatMap((p) => p.entries), ...allAccounts]) for (const w of e.works ?? []) {
    if (w.duration == null && w.media?.duration) w.duration = Math.round(w.media.duration);
  }
  result.elapsed_s = Math.round((Date.now() - started) / 1000);
  const dir = path.join(opts.out, day);
  // 来自采集清单的专精另写竞对数据包（多个时文件名带专精名）；要在写 data.json 之前，media 里的时长还在
  const lists = result.focus.filter((f) => f.watchlist);
  for (const f of lists) {
    f.pack = path.join(dir, lists.length > 1 ? `竞对数据包-${f.name}-${day}.json` : `竞对数据包-${day}.json`);
    writePack(opts.out, f.pack, f, result);
  }
  writeData(dir, result);
  let picks = [];
  try {
    picks = curate(opts.out).items.filter((x) => x.date === day);
  } catch (e) {
    result.curate_error = e.message;
    log('精选', `失败：${e.message}`);
  }
  const report = writeReport(dir, result, picks);
  const stat = (p) => {
    const ok = p.entries.filter((e) => e.creator && !e.same_as);
    const works = ok.flatMap((e) => e.works);
    return {
      status: p.status, board_date: p.board?.date ?? null, entries: p.entries.length, authors: ok.length,
      works: works.length, copies: works.filter((w) => w.copy?.chars).length, no_speech: works.filter((w) => w.copy?.chars === 0).length, elapsed_s: p.elapsed_s ?? 0,
      ...(p.error ? { error: p.error } : {}),
    };
  };
  const summary = {
    date: day,
    elapsed_s: result.elapsed_s,
    budget_exhausted: result.budget_exhausted,
    report,
    picks: picks.length,
    platforms: Object.fromEntries(result.platforms.filter((p) => !p.focus).map((p) => [p.name, stat(p)])),
    ...(result.focus.length ? { focus: Object.fromEntries(result.focus.map((f) => [f.name, {
      ...(f.error ? { error: f.error } : {}),
      boards: Object.fromEntries(result.platforms.filter((p) => p.focus === f.name).map((p) => [`${p.name}:${p.category}`, stat(p)])),
      accounts: { total: f.accounts.length, ok: f.accounts.filter((x) => x.creator).length, skipped: f.accounts.filter((x) => x.skipped).length, failed: f.accounts.filter((x) => x.error).length },
      ...(f.pack ? { pack: f.pack } : {}),
    }])) } : {}),
  };
  console.log(JSON.stringify(summary));
}

try {
  await main();
} catch (e) {
  log('出错', e.stack ?? e.message);
  process.exitCode = 1;
} finally {
  killAsr();
  await closeAllBrowsers();
}
