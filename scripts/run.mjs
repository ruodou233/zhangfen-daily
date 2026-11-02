#!/usr/bin/env node
// 涨粉榜日报：榜单 → 作者 → 榜期附近作品 → 代表作文案 → report.md / data.json
// node scripts/run.mjs --out <dir> [--platforms bilibili,douyin,xhs] [--top 10] [--copy 2] [--window 14]
//                      [--budget-min 30] [--chrome-profile <Chrome 用户数据目录>] [--python <解释器>]
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
    platforms: { type: 'string', default: 'bilibili,douyin,xhs' },
    top: { type: 'string', default: '10' },
    copy: { type: 'string', default: '2' },
    window: { type: 'string', default: '14' },
    'budget-min': { type: 'string', default: '30' },
    'chrome-profile': { type: 'string' },
    python: { type: 'string' },
  },
});
if (!a.out) {
  console.error('用法：node scripts/run.mjs --out <目录> [--platforms bilibili,douyin,xhs] [--top 10] [--copy 2] [--window 14] [--budget-min 30]');
  process.exit(2);
}
const opts = {
  out: path.resolve(a.out),
  platforms: a.platforms.split(',').map((s) => s.trim()).filter(Boolean),
  top: +a.top,
  copy: +a.copy,
  window: +a.window,
  budget_min: +a['budget-min'],
  chromeProfile: a['chrome-profile'],
  python: a.python,
};

const pad = (n) => String(n).padStart(2, '0');
const now = () => new Date();
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

// 文案缓存：头部几行元信息，空行后是正文
function readCopy(file) {
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, 'utf8');
  const i = raw.indexOf('\n\n');
  return { source: raw.slice(0, i).match(/^来源：(.+)$/m)?.[1] ?? 'text', chars: raw.slice(i + 2).trim().length };
}

function writeCopy(file, work, c) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const head = [`标题：${(work.title || '').replace(/\s+/g, ' ')}`, `链接：${work.url}`, `发布：${work.published_at ?? ''}`, `来源：${c.source}`];
  fs.writeFileSync(file, `${head.join('\n')}\n\n${c.text}\n`);
}

const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1) || (y.metrics?.plays ?? -1) - (x.metrics?.plays ?? -1);

async function runPlatform(mod, ctx, p, result) {
  const b = await mod.board(ctx);
  p.board = { date: b.date, period: b.period, url: b.url };
  ctx.log(`榜期 ${b.date}（${b.period}），${b.entries.length} 位`);
  for (const entry of b.entries) {
    const e = { ...entry };
    p.entries.push(e);
    if (Date.now() > ctx.deadline) { e.error = '预算用完，跳过'; result.budget_exhausted = true; continue; }
    try {
      const w = await mod.works(ctx, entry, b);
      Object.assign(e, { creator: w.creator, works: w.works ?? [], note: w.note || undefined });
    } catch (err) {
      e.error = err.message;
      ctx.log(`#${entry.rank} ${entry.name} 失败：${err.message}`);
      continue;
    }
    ctx.log(`#${entry.rank} ${entry.name}：窗口内 ${e.works.length} 条`);
    for (const w of [...e.works].sort(byLikes).slice(0, ctx.opts.copy)) {
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
  const day = ymd(now());
  cleanStale();
  const deadline = started + opts.budget_min * 60_000;
  const asr = createAsr({ python: opts.python, log: (m) => log('转写', m) });
  const result = {
    date: day,
    generated_at: now().toISOString(),
    opts: { platforms: opts.platforms, top: opts.top, copy: opts.copy, window: opts.window, budget_min: opts.budget_min },
    budget_exhausted: false,
    platforms: [],
  };

  for (const name of opts.platforms) {
    const p = { name, label: name, status: 'ok', entries: [] };
    result.platforms.push(p);
    let mod;
    try {
      mod = await import(`./platforms/${name}.mjs`);
      p.label = mod.label ?? name;
    } catch (e) {
      Object.assign(p, { status: 'unavailable', error: `模块未就绪（${e.code === 'ERR_MODULE_NOT_FOUND' && e.message.includes(`${name}.mjs`) ? '文件不存在' : e.message}）` });
      log(name, p.error);
      continue;
    }
    if (Date.now() > deadline) {
      Object.assign(p, { status: 'skipped', error: '预算用完，未运行' });
      result.budget_exhausted = true;
      continue;
    }
    let session;
    const ctx = {
      opts, deadline, http, asr,
      log: (m) => log(p.label, m),
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
