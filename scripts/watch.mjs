#!/usr/bin/env node
// 竞对监控：按「采集清单」里的主页链接取指定账号近 N 天的作品、数据、文案和热评，再取几个垂类涨粉榜，
// 输出一个「竞对数据包」JSON，给自媒体工作台导入。和日报共用平台模块、无头浏览器、本地转写和文案缓存。
// node scripts/watch.mjs --list <采集清单.json> --out <目录> [--board douyin:教育校园 ...] [--window 14] [--copy 3]
//                       [--board-top 10] [--board-detail 5] [--board-copy 1] [--budget-min 40] [--chrome-profile <目录>] [--python <解释器>]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import * as http from './lib/http.mjs';
import { launchBrowser, closeAllBrowsers } from './lib/browser.mjs';
import { createAsr, killAsr } from './lib/asr.mjs';

const { values: a } = parseArgs({
  options: {
    list: { type: 'string' },
    out: { type: 'string' },
    board: { type: 'string', multiple: true },
    window: { type: 'string', default: '14' },
    copy: { type: 'string', default: '3' },
    'board-top': { type: 'string', default: '10' },
    'board-detail': { type: 'string', default: '5' }, // 榜上前几名去取作品（其余只留榜单数据），控制访问量
    'board-copy': { type: 'string', default: '1' },
    'budget-min': { type: 'string', default: '40' },
    'chrome-profile': { type: 'string' },
    python: { type: 'string' },
  },
});
if (!a.out || (!a.list && !a.board?.length)) {
  console.error('用法：node scripts/watch.mjs --list <采集清单.json> --out <目录> [--board douyin:教育校园 ...]');
  process.exit(2);
}

// 指定账号支持的平台（模块要有 parseUrl）；分类榜看模块是否导出 CATEGORIES
const SUPPORTED = { douyin: '抖音', xhs: '小红书', bilibili: 'B站' };
const DAY = 86_400_000;
const dayIn = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
const pad = (n) => String(n).padStart(2, '0');
const log = (tag, msg) => { const d = new Date(); console.error(`[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}] [${tag}] ${msg}`); };
const safeName = (id) => String(id).replace(/[^\w.-]/g, '_');

const out = path.resolve(a.out);
const watchlist = a.list ? JSON.parse(fs.readFileSync(a.list, 'utf8')) : { accounts: [], boards: [] };
if (a.list && watchlist.kind !== 'mwb-watchlist') throw new Error(`${a.list} 不是工作台导出的采集清单（kind=${watchlist.kind}）`);
const boards = [...new Set([...(watchlist.boards ?? []), ...(a.board ?? [])])];
const opts = {
  out, window: +a.window, copy: +a.copy, top: +a['board-top'],
  boardDetail: +a['board-detail'], boardCopy: +a['board-copy'], budget_min: +a['budget-min'], chromeProfile: a['chrome-profile'],
};
const deadline = Date.now() + opts.budget_min * 60_000;
const today = dayIn(Date.now());

// 文案缓存和日报共用 <out>/copy/<平台>/<作品ID>.json（日报的 .txt 只有正文，这里要热评结构，所以另存 json）
function cachedCopy(platform, id) {
  const f = path.join(out, 'copy', platform, `${safeName(id)}.json`);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}
function saveCopy(platform, id, c) {
  const f = path.join(out, 'copy', platform, `${safeName(id)}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(c));
}

// 只留工作台用得到的字段；media 之类的下载地址不带出去
// 文案为空（视频里没有人声、正文也空）的不算带文案，工作台只收带文案的作品
const slim = (w) => {
  const empty = w.copy && !w.copy.text;
  return {
    id: w.id, url: w.url, title: w.title, type: w.type, published_at: w.published_at,
    duration: Math.round(w.duration ?? w.media?.duration ?? 0) || null, metrics: w.metrics, desc: w.desc ?? '',
    ...(w.copy && !empty ? { copy: w.copy } : {}),
    ...(empty ? { copy_error: '没有可用文案（视频里没有人声）' } : w.copy_error ? { copy_error: w.copy_error } : {}),
  };
};

const byLikes = (x, y) => (y.metrics?.likes ?? -1) - (x.metrics?.likes ?? -1);

async function fillCopies(mod, ctx, platform, works, n) {
  for (const w of [...works].sort(byLikes).slice(0, n)) {
    const hit = cachedCopy(platform, w.id);
    if (hit) { w.copy = hit; continue; }
    if (Date.now() > deadline) { w.copy_error = '预算用完，跳过'; continue; }
    try {
      const c = await mod.copy(ctx, w);
      w.copy = { source: c.source, text: (c.text ?? '').trim(), comments: (c.comments ?? []).filter((x) => x.text?.trim()).slice(0, 10) };
      saveCopy(platform, w.id, w.copy);
      ctx.log(`  ${w.id} 文案 ${w.copy.text.length} 字（${c.source}）`);
    } catch (e) {
      w.copy_error = e.message;
      ctx.log(`  ${w.id} 文案失败：${e.message}`);
    }
  }
}

async function main() {
  const started = Date.now();
  const asr = createAsr({ python: a.python, log: (m) => log('转写', m) });
  const pack = { kind: 'zhangfen-watch', version: 1, date: today, generated_at: new Date().toISOString(), window: opts.window, accounts: [], boards: [], skipped: [] };

  const accounts = (watchlist.accounts ?? []).filter((x) => {
    if (SUPPORTED[x.platform] && x.url) return true;
    pack.skipped.push({ input: { name: x.name, url: x.url, platform: x.platform }, reason: !x.url ? '没有主页链接' : '这个平台暂不支持自动采集' });
    return false;
  });
  const platforms = [...new Set([...accounts.map((x) => x.platform), ...boards.map((b) => b.split(':')[0])])];

  // 一个平台一个浏览器会话，平台之间串行：小红书、抖音的风控都对频率敏感，指定账号本来也不多
  for (const platform of platforms) {
    let mod;
    try {
      mod = await import(`./platforms/${platform}.mjs`);
    } catch {
      log('跳过', `不认识的平台 ${platform}`);
      for (const key of boards.filter((b) => b.startsWith(platform + ':'))) {
        pack.boards.push({ platform, label: platform, category: key.split(':')[1], entries: [], error: `不认识的平台 ${platform}` });
      }
      continue;
    }
    let session;
    const ctx = {
      opts, deadline, http,
      log: (m) => log(mod.label, m),
      asr: (input, o = {}) => asr(input, { ...o, log: (m) => log(mod.label, `转写：${m}`) }),
      browser: () => (session ??= launchBrowser({ chromeProfile: opts.chromeProfile })),
    };
    const board = { date: today };
    try {
      // ---- 指定账号 ----
      for (const x of accounts.filter((y) => y.platform === platform)) {
        const rec = { ref: x.ref, platform, label: mod.label, input: { name: x.name, url: x.url }, works: [] };
        pack.accounts.push(rec);
        if (Date.now() > deadline) { rec.error = '预算用完，跳过'; continue; }
        try {
          const ref = await mod.parseUrl(ctx, x.url);
          const w = await mod.works({ ...ctx, opts: { ...opts, copy: opts.copy } }, { name: x.name, ref, followers: null }, board);
          rec.creator = w.creator;
          if (w.note) rec.note = w.note;
          await fillCopies(mod, ctx, platform, w.works ?? [], opts.copy);
          rec.works = (w.works ?? []).sort(byLikes).map(slim);
          ctx.log(`${x.name}：窗口内 ${rec.works.length} 条，带文案 ${rec.works.filter((y) => y.copy).length} 条`);
        } catch (e) {
          rec.error = e.message;
          ctx.log(`${x.name} 失败：${e.message}`);
        }
      }
      // ---- 垂类涨粉榜 ----
      for (const key of boards.filter((b) => b.startsWith(platform + ':'))) {
        const category = key.split(':')[1];
        const rec = { platform, label: mod.label, category, entries: [] };
        pack.boards.push(rec);
        if (!mod.CATEGORIES) { rec.error = `${mod.label}没有分类涨粉榜`; continue; }
        try {
          const b = await mod.board({ ...ctx, opts: { ...opts, top: opts.top } }, { category });
          Object.assign(rec, { date: b.date, period: b.period, url: b.url });
          ctx.log(`${category} 榜 ${b.date}，${b.entries.length} 位`);
          for (const entry of b.entries) {
            const e = { rank: entry.rank, name: entry.name, gain: entry.gain, followers: entry.followers, creator: null, works: [] };
            rec.entries.push(e);
            if (entry.rank > opts.boardDetail || Date.now() > deadline) continue;
            try {
              const w = await mod.works({ ...ctx, opts: { ...opts, copy: opts.boardCopy } }, entry, b);
              e.creator = w.creator;
              await fillCopies(mod, ctx, platform, w.works ?? [], opts.boardCopy);
              e.works = (w.works ?? []).sort(byLikes).slice(0, 3).map(slim);
            } catch (err) {
              e.error = err.message;
              ctx.log(`#${entry.rank} ${entry.name} 失败：${err.message}`);
            }
          }
        } catch (e) {
          rec.error = e.message;
          ctx.log(`${category} 榜失败：${e.message}`);
        }
      }
    } finally {
      if (session) await (await session.catch(() => null))?.close();
    }
  }

  fs.mkdirSync(path.join(out, today), { recursive: true });
  const file = path.join(out, today, `竞对数据包-${today}.json`);
  fs.writeFileSync(file, JSON.stringify(pack, null, 1));
  const n = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
  console.log(JSON.stringify({
    date: today, elapsed_s: Math.round((Date.now() - started) / 1000), pack: file,
    accounts: pack.accounts.length, failed: pack.accounts.filter((x) => x.error).length,
    works: n(pack.accounts, (x) => x.works.length), copies: n(pack.accounts, (x) => x.works.filter((w) => w.copy).length),
    boards: pack.boards.map((b) => `${b.label}·${b.category} ${b.error ? '失败' : b.entries.length + ' 位'}`), skipped: pack.skipped.length,
  }));
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
