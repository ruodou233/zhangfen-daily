// 无头 Chrome 会话：复制日常 profile 的 Cookies → 正版 Chrome --headless=new → 最小 CDP 客户端。
// 只用 Node 内置 WebSocket / child_process。临时目录名带属主 pid，run.mjs 启动时据此清理残留。
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = '/Applications/Google Chrome.app';
const BINARY = `${APP}/Contents/MacOS/Google Chrome`;
const DEFAULT_PROFILE = path.join(os.homedir(), 'Library/Application Support/Google/Chrome');
const PAGE_TIMEOUT = 45_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 与本机 Chrome 主版本一致的普通 Mac Chrome UA
export function chromeUA() {
  let major = '130';
  try { major = fs.readFileSync(`${APP}/Contents/Info.plist`, 'utf8').match(/CFBundleShortVersionString<\/key>\s*<string>(\d+)/)[1]; } catch {}
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const live = new Set(); // 还没关掉的会话，进程退出时兜底

process.on('exit', () => {
  for (const s of live) s.kill();
});

export async function launchBrowser({ chromeProfile = DEFAULT_PROFILE } = {}) {
  if (!fs.existsSync(BINARY)) throw new Error(`没找到 ${BINARY}`);
  const src = [path.join(chromeProfile, 'Default/Cookies'), path.join(chromeProfile, 'Cookies')].find((f) => fs.existsSync(f));
  if (!src) throw new Error(`${chromeProfile} 下没有 Cookies 文件`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `zhangfen-chrome-${process.pid}-`));
  let proc;
  const kill = () => {
    if (proc?.pid) { try { process.kill(-proc.pid, 'SIGKILL'); } catch {} }
    try { execFileSync('pkill', ['-9', '-f', dir], { stdio: 'ignore' }); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const handle = { kill };
  live.add(handle);

  try {
    // sqlite 在线备份拿一致快照，日常 Chrome 开着也没关系
    fs.mkdirSync(path.join(dir, 'Default'));
    execFileSync('sqlite3', [`file:${src}?mode=ro`, `.backup '${path.join(dir, 'Default/Cookies')}'`], { stdio: 'ignore', timeout: 20_000 });

    proc = spawn(BINARY, [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      `--user-agent=${chromeUA()}`,
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--mute-audio',
      '--window-size=1440,900',
      'about:blank',
    ], { detached: true, stdio: 'ignore' });
    proc.unref();

    const portFile = path.join(dir, 'DevToolsActivePort');
    let wsUrl;
    for (let i = 0; i < 150 && !wsUrl; i++) {
      await sleep(100);
      const [port, wsPath] = fs.existsSync(portFile) ? fs.readFileSync(portFile, 'utf8').trim().split('\n') : [];
      if (port && wsPath) wsUrl = `ws://127.0.0.1:${port}${wsPath}`;
    }
    if (!wsUrl) throw new Error('Chrome 15 秒内没有启动');
    const cdp = await connect(wsUrl);
    const session = makeSession(cdp, proc, handle);
    handle.close = session.close;
    return session;
  } catch (e) {
    kill();
    live.delete(handle);
    throw e;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('连不上 Chrome 调试端口')); });
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result);
    } else if (msg.method) {
      for (const fn of listeners) fn(msg);
    }
  };
  ws.onclose = () => {
    for (const p of pending.values()) { clearTimeout(p.timer); p.rej(new Error('Chrome 连接已断开')); }
    pending.clear();
  };
  const send = (method, params = {}, sessionId, timeout = PAGE_TIMEOUT) =>
    new Promise((res, rej) => {
      if (ws.readyState !== WebSocket.OPEN) return rej(new Error('Chrome 连接已断开'));
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 超时`)); }, timeout);
      pending.set(id, { res, rej, timer, method });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  const on = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
  return { send, on, close: () => ws.close() };
}

function makeSession(cdp, proc, handle) {
  let closed = false;
  return {
    // 后台新开一个 target 打开 url。capture 里的正则命中的响应会收进 page.responses。
    async open(url, { capture = [], waitMs = 3000 } = {}) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', background: true });
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      const page = makePage(cdp, targetId, sessionId, capture);
      try {
        await page.send('Page.enable');
        await page.send('Runtime.enable');
        await page.send('Network.enable');
        await page.goto(url, { waitMs });
      } catch (e) {
        await page.close();
        throw e;
      }
      return page;
    },

    // 给 HTTP 下载用的 Cookie 头：返回对该主机生效的全部 cookie
    async cookieHeader(domain) {
      const host = /^https?:/.test(domain) ? new URL(domain).hostname : domain.replace(/^\./, '');
      const { cookies } = await cdp.send('Storage.getCookies');
      return cookies
        .filter((c) => { const d = c.domain.replace(/^\./, ''); return host === d || host.endsWith('.' + d); })
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    },

    async close() {
      if (closed) return;
      closed = true;
      try { await cdp.send('Browser.close', {}, undefined, 3000); } catch {}
      cdp.close();
      for (let i = 0; i < 30; i++) {
        try { process.kill(proc.pid, 0); } catch { break; }
        await sleep(100);
      }
      handle.kill();
      live.delete(handle);
    },
  };
}

function makePage(cdp, targetId, sessionId, capture) {
  const send = (method, params) => cdp.send(method, params, sessionId);
  const responses = [];
  const hits = new Map(); // requestId → { url, status }
  const off = cdp.on(async (m) => {
    if (m.sessionId !== sessionId || !capture.length) return;
    if (m.method === 'Network.responseReceived') {
      const { url, status } = m.params.response;
      if (capture.some((re) => re.test(url))) hits.set(m.params.requestId, { url, status });
    } else if (m.method === 'Network.loadingFinished' && hits.has(m.params.requestId)) {
      const hit = hits.get(m.params.requestId);
      hits.delete(m.params.requestId);
      try {
        const { body, base64Encoded } = await send('Network.getResponseBody', { requestId: m.params.requestId });
        const text = base64Encoded ? Buffer.from(body, 'base64').toString('utf8') : body;
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        responses.push({ ...hit, body: parsed });
      } catch (e) {
        responses.push({ ...hit, body: null, error: e.message });
      }
    }
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };

  return {
    targetId,
    responses,
    send,
    eval: evaluate,

    async goto(url, { waitMs = 3000 } = {}) {
      let done;
      const loaded = new Promise((res) => { done = res; });
      const stop = cdp.on((m) => { if (m.sessionId === sessionId && m.method === 'Page.loadEventFired') done(); });
      const timer = setTimeout(done, PAGE_TIMEOUT);
      try {
        const nav = await send('Page.navigate', { url });
        if (nav.errorText) throw new Error(`打开 ${url} 失败：${nav.errorText}`);
        await loaded;
      } finally {
        stop();
        clearTimeout(timer);
      }
      if (waitMs) await sleep(waitMs);
    },

    // cond：页面里求值的 JS 表达式字符串，或 Node 侧函数（可 async）。返回第一个真值，超时抛错。
    async waitFor(cond, timeoutMs = 15_000) {
      const end = Date.now() + Math.min(timeoutMs, PAGE_TIMEOUT);
      for (;;) {
        const v = typeof cond === 'function' ? await cond() : await evaluate(cond).catch(() => null);
        if (v) return v;
        if (Date.now() > end) throw new Error(`等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
        await sleep(300);
      }
    },

    async close() {
      off();
      try { await cdp.send('Target.closeTarget', { targetId }, undefined, 5000); } catch {}
    },
  };
}

// 进程收到信号时用：关掉本进程开的全部会话
export async function closeAllBrowsers() {
  await Promise.all([...live].map((s) => (s.close ? s.close() : (s.kill(), live.delete(s)))));
}
