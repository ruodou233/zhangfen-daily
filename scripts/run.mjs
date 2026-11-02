#!/usr/bin/env node
// 涨粉榜日报：榜单 → 作者 → 榜期附近作品 → 代表作文案 → report.md / data.json
// node scripts/run.mjs --out <dir> [--platforms bilibili,xhs,youtube,douyin,x,kuaishou,channels] [--concurrency 2]
//                      [--top 10] [--copy 2] [--window 14] [--budget-min 45] [--chrome-profile <Chrome 用户数据目录>] [--python <解释器>]
// 平台按列表顺序进 --concurrency 个并发槽；默认顺序把纯 HTTP 的平台和浏览器重的平台交错开。转写全局排队，一次一个。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as http from './lib/http.mjs';
import { launchBrowser, closeAllBrowsers } from './lib/browser.mjs';
import { createAsr, killAsr } from './lib/asr.mjs';
import { writeReport } from './lib/report.mjs';

const { values: a } = parseArgs({
  options: {
    out: { type: 'string' },
    platforms: { type: 'string', default: 'bilibili,xhs,youtube,douyin,x,kuaishou,channels' },
    concurrency: { type: 'string', default: '2' },
    top: { type: 'string', default: '10' },
    copy: { type: 'string', default: '2' },
    window: { type: 'string', default: '14' },
    'budget-min': { type: 'string', default: '45' },
    'chrome-profile': { type: 'string' },
    python: { type: 'string' },
  },
});
if (!a.out) {
  console.error('用法：node scripts/run.mjs --out <目录> [--platforms bilibili,xhs,youtube,douyin,x,kuaishou,channels] [--concurrency 2] [--top 10] [--copy 2] [--window 14] [--budget-min 45]');
  process.exit(2);
}
const opts = {
  out: path.resolve(a.out),
  platforms: a.platforms.split(',').map((s) => s.trim()).filter(Boolean),
  concurrency: Math.max(1, +a.concurrency || 1),
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
  return { source: raw.slice(0, i).match(/^来源：(.+)$/m)?.[1] ?? 'text', chars: raw.slice(i + 2).split(HOT)[0].trim().length };
}

function writeCopy(file, work, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = [`标题：${(work.title || '').replace(/\s+/g, ' ')}`, `链接：${work.url}`, `发布：${work.published_at ?? ''}`, `来源：${c.source}`];
  const hot = (c.comments ?? []).filter((x) => x.text?.trim()).map((x) => `- ${x.text.replace(/\s+/g, ' ').trim()}（赞 ${x.likes ?? '—'}）`);
  fs.writeFileSync(file, `${head.join('\n')}\n\n${c.text}\n${hot.length ? `${HOT}\n${hot.join('\n')}\n` : ''}`);
}

const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1) || (y.metrics?.plays ?? -1) - (x.metrics?.plays ?? -1);
const daysBefore = (date, iso, tz) => dayNo(date) - dayNo(dayIn(Date.parse(iso), tz));

// 代表作：有峰值日时先给「峰值日及前 3 天内发布、点赞最高」的一条，其余名额按点赞
function pickReps(works, peak, n, tz) {
  const sorted = [...works].sort(byLikes);
  const near = peak && sorted.find((w) => { const d = daysBefore(peak.date, w.published_at, tz); return d >= 0 && d <= 3; });
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
    const q = prev?.platforms.find((x) => x.name === p.name);
    const same = !!p.board && q?.board?.date === p.board.date;
    if (same) p.board.unchanged = true;
    for (const e of p.entries) {
      const o = q?.entries.find((x) => (e.creator?.id != null && String(x.creator?.id) === String(e.creator.id)) || x.name === e.name);
      e.streak = o ? (o.streak ?? 1) + (same ? 0 : 1) : 1;
    }
  }
}

async function runPlatform(mod, ctx, p, result) {
  const b = await mod.board(ctx);
  p.board = { date: b.date, period: b.period, url: b.url, tz: b.tz ?? TZ };
  ctx.log(`榜期 ${b.date}（${b.period}），${b.entries.length} 位`);
  for (const entry of b.entries) {
    const e = { ...entry };
    p.entries.push(e);
    if (Date.now() > ctx.deadline) { e.error = '预算用完，跳过'; result.budget_exhausted = true; continue; }
    try {
      const w = await mod.works(ctx, entry, b);
      Object.assign(e, { creator: w.creator, works: w.works ?? [], note: w.note || undefined, peak: w.peak ?? undefined });
    } catch (err) {
      e.error = err.message;
      ctx.log(`#${entry.rank} ${entry.name} 失败：${err.message}`);
      continue;
    }
    ctx.log(`#${entry.rank} ${entry.name}：窗口内 ${e.works.length} 条`);
    for (const w of pickReps(e.works, e.peak, ctx.opts.copy, p.board.tz)) {
      w.representative = true;
      const file = path.join('copy', p.name, `${safeName(w.id)}.txt`);
      const abs = path.join(ctx.opts.out, file);
      const cached = readCopy(abs);
      if (cached) { w.copy = { ...cached, file, cached: true }; continue; }
      if (Date.now() > ctx.deadline) { w.copy_error = '预算用完，跳过'; result.budget_exhausted = true; continue; }
      try {
        const c = await mod.copy(ctx, w);
        c.text = c.text?.trim() ?? ''; // 空文案（未转出有效语音、正文为空）也缓存：同一模型重转结果一样
        writeCopy(abs, w, c);
        w.copy = { source: c.source, file, chars: c.text.length };
        ctx.log(`  ${w.id} 文案 ${w.copy.chars} 字（${c.source}）`);
      } catch (err) {
        w.copy_error = err.message;
        ctx.log(`  ${w.id} 文案失败：${err.message}`);
      }
    }
  }
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
    opts: { platforms: opts.platforms, concurrency: opts.concurrency, top: opts.top, copy: opts.copy, window: opts.window, budget_min: opts.budget_min },
    budget_exhausted: false,
    platforms: [],
  };

  // 每个平台一个自己的浏览器会话（懒启动，平台跑完就关）；asr 全局共用、内部排队
  async function runOne(p) {
    let mod;
    try {
      mod = await import(`./platforms/${p.name}.mjs`);
      p.label = mod.label ?? p.name;
    } catch (e) {
      Object.assign(p, { status: 'unavailable', error: `模块未就绪（${e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(`${p.name}.mjs`) ? '文件不存在' : e.message}）` });
      log(p.name, p.error);
      return;
    }
    if (Date.now() > deadline) {
      Object.assign(p, { status: 'skipped', error: '预算用完，未运行' });
      result.budget_exhausted = true;
      return;
    }
    let session;
    const ctx = {
      opts, deadline, http,
      log: (m) => log(p.label, m),
      asr: (input, o = {}) => asr(input, { ...o, log: (m) => log(p.label, `转写：${m}`) }),
      browser: () => (session ??= launchBrowser({ chromeProfile: opts.chromeProfile })),
    };
    const t = Date.now();
    try {
      await runPlatform(mod, ctx, p, result);
    } catch (e) {
      Object.assign(p, { status: 'failed', error: e.message });
      log(p.label, `失败：${e.message}`);
    } finally {
      if (session) await (await session.catch(() => null))?.close();
    }
    p.elapsed_s = Math.round((Date.now() - t) / 1000);
  }

  result.platforms = opts.platforms.map((name) => ({ name, label: name, status: 'ok', entries: [] }));
  const todo = [...result.platforms];
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, todo.length) }, async () => {
    for (let p; (p = todo.shift());) await runOne(p);
  }));

  markStreaks(result);
  result.elapsed_s = Math.round((Date.now() - started) / 1000);
  const report = writeReport(path.join(opts.out, day), result);
  const summary = {
    date: day,
    elapsed_s: result.elapsed_s,
    budget_exhausted: result.budget_exhausted,
    report,
    platforms: Object.fromEntries(result.platforms.map((p) => {
      const ok = p.entries.filter((e) => e.creator);
      const works = ok.flatMap((e) => e.works);
      return [p.name, {
        status: p.status, board_date: p.board?.date ?? null, entries: p.entries.length, authors: ok.length,
        works: works.length, copies: works.filter((w) => w.copy?.chars).length, no_speech: works.filter((w) => w.copy?.chars === 0).length, elapsed_s: p.elapsed_s ?? 0,
        ...(p.error ? { error: p.error } : {}),
      }];
    })),
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
