// 转写：媒体 URL（连同请求头）或本地文件直接交给 asr.py，ffmpeg 边下边抽音频。超时按音频时长给。
import { spawn, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UA } from './http.mjs';

const SCRIPT = fileURLToPath(new URL('../asr.py', import.meta.url));
const CANDIDATES = [path.join(os.homedir(), '.workbuddy/binaries/python/envs/default/bin/python'), 'python3'];

const children = new Set();

export function killAsr() {
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL'); } catch {} }
  children.clear();
}
process.on('exit', killAsr);

function findPython(explicit) {
  for (const c of explicit ? [explicit] : [process.env.ZF_PYTHON, ...CANDIDATES].filter(Boolean)) {
    try {
      execFileSync(c, ['-c', 'import mlx_whisper'], { stdio: 'ignore', timeout: 60_000 });
      return c;
    } catch {}
  }
  throw new Error('找不到装了 mlx-whisper 的 Python（用 --python 或 ZF_PYTHON 指定）');
}

export function createAsr({ python, log = () => {} } = {}) {
  let py;
  return async function asr(input, { headers = {} } = {}) {
    py ??= (() => { try { return findPython(python); } catch (e) { return e; } })();
    if (py instanceof Error) throw py;
    const args = [SCRIPT, input];
    if (/^https?:/.test(input)) {
      const h = { 'User-Agent': UA, ...headers };
      args.push('--headers', Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join(''));
    }
    return transcribe(py, args, log);
  };
}

function transcribe(py, args, log) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(py, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let out = '';
    let err = '';
    let timer;
    const limit = (sec) => {
      clearTimeout(timer);
      timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, sec * 1000);
    };
    limit(300); // 拉流抽音频阶段
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => {
      err += d;
      const m = err.match(/duration ([\d.]+)/);
      if (m && !child.durationSeen) {
        child.durationSeen = true;
        log(`抽出 ${Math.round(m[1])} 秒音频（${Math.round((Date.now() - t0) / 1000)} 秒），开始转写`);
        limit(90 + m[1] * 0.5);
      }
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      children.delete(child);
      if (code === 0) return resolve(out.trim()); // 空串表示没转出有效语音
      const last = err.trim().split('\n').filter((l) => !/^duration /.test(l)).pop();
      reject(new Error(signal ? `转写超时或被中止（${signal}）` : `转写失败：${last ?? `退出码 ${code}`}`));
    });
  });
}
