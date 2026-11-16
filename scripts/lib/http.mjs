// fetch 包装：普通 Chrome UA、默认 20 秒超时、自动跟随重定向（redirect: 'manual' 可自己读 Location）。
import { chromeUA } from './browser.mjs';

export const UA = chromeUA();
const TIMEOUT = 20_000;

// 返回 Response；网络错误、超时抛错，HTTP 状态码不判断
export function request(url, { headers = {}, timeout = TIMEOUT, ...init } = {}) {
  return fetch(url, {
    ...init,
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9', ...headers },
    signal: AbortSignal.timeout(timeout),
  });
}

async function ok(url, opts) {
  const res = await request(url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
  return res;
}

export const text = async (url, opts) => (await ok(url, opts)).text();
export const json = async (url, opts) => (await ok(url, opts)).json();

