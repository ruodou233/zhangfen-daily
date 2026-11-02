"""转写：python asr.py <媒体文件或 URL> [--language zh] [--headers "K: V\\r\\n..."] [--model <本地模型目录>] [--max-sec 1800]

ffmpeg 直接从文件或 URL 流式抽前 max-sec 秒的 16k 单声道 PCM，mlx-whisper 用本地 whisper-large-v3-turbo 转写，
不给 --language 就自动识别语言。纯文本按句换行写到 stdout，长于 max-sec 时末尾注明只转了前一段。
抽完音频先往 stderr 打一行 `duration <秒>`，调用方据此定超时。没转出有效语音时输出为空。
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import threading
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")

# 纯音乐、静音段上 whisper 常编出这些固定说法；v3-turbo 的 no_speech_prob 不可靠，靠置信度和黑名单
HALLUCINATION = {
    "zh": re.compile(r"字幕(志愿者|制作|提供|翻译|校对|由|组)|^(中文)?字幕[\s:：]|Amara|明镜|点点栏目|不吝|独播剧场|YoYo"
                     r"|谢谢观看|感谢观看|感谢收看|订阅.{0,8}转发"),
}
KANA = re.compile(r"[\u3040-\u30ff]")
LETTER = re.compile(r"[\u3040-\u30ff\u4e00-\u9fffA-Za-z]")


def speech(seg, lang):
    t = seg["text"].strip()
    if not re.search(r"\w", t):  # 只有标点
        return ""
    if not seg.get("avg_logprob", 0) >= -1.0 or seg.get("compression_ratio", 0) > 2.4:  # 低置信、复读；NaN 也丢
        return ""
    if seg["end"] - seg["start"] >= 20 and len(t) < 20:  # 整个窗口只出一句短话（Thank you. 之类），多半是音乐上编的
        return ""
    if lang in HALLUCINATION and HALLUCINATION[lang].search(t):
        return ""
    kana = len(KANA.findall(t))
    if lang == "zh" and kana and kana >= 0.5 * len(LETTER.findall(t)):  # 整段是日文：按中文转时这多半是幻觉
        return ""
    return t


def find_ffmpeg():
    for c in (shutil.which("ffmpeg"), os.path.expanduser("~/.local/bin/ffmpeg")):
        if c and os.path.exists(c):
            return c
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit("找不到 ffmpeg")


def find_model():
    # 必须传本地目录；传仓库名 mlx 会去联网
    env = os.environ.get("ZF_WHISPER_MODEL")
    if env:
        return env
    hub = os.environ.get("HF_HUB_CACHE") or os.path.expanduser("~/.cache/huggingface/hub")
    for d in sorted(glob.glob(f"{hub}/models--mlx-community--whisper-large-v3-turbo/snapshots/*/")):
        if glob.glob(d + "weights.*"):
            return d
    sys.exit("本地没有 whisper-large-v3-turbo，先下载：huggingface-cli download mlx-community/whisper-large-v3-turbo")


RUNNING = {}  # 正在跑的 ffmpeg


def exit_with_parent():
    # 调用方被强杀时连同 ffmpeg 一起退出，不留孤儿进程
    parent = os.getppid()
    while os.getppid() == parent:
        time.sleep(2)
    if RUNNING.get("ffmpeg"):
        RUNNING["ffmpeg"].kill()
    os._exit(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("media")
    ap.add_argument("--language", default=None)
    ap.add_argument("--headers", default="")
    ap.add_argument("--model", default=None)
    ap.add_argument("--max-sec", type=int, default=1800)
    a = ap.parse_args()
    model = a.model or find_model()
    threading.Thread(target=exit_with_parent, daemon=True).start()

    src = ["-i", a.media]
    if re.match(r"https?://", a.media):
        src = ["-rw_timeout", "20000000"] + (["-headers", a.headers] if a.headers else []) + src
    # info 级日志里有输入全长（Duration: 00:44:41.00），截断时用来标注
    ff = RUNNING["ffmpeg"] = subprocess.Popen(
        [find_ffmpeg(), "-nostdin", "-nostats", "-v", "info", *src, "-t", str(a.max_sec),
         "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    pcm, log = ff.communicate()
    log = log.decode(errors="replace")
    if ff.returncode:
        sys.exit("ffmpeg：" + (log.strip().splitlines() or ["退出码 %d" % ff.returncode])[-1])

    import numpy as np
    audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768.0
    print(f"duration {len(audio) / 16000:.1f}", file=sys.stderr, flush=True)
    if len(audio) < 16000:
        return

    import mlx_whisper
    from mlx_whisper.tokenizer import LANGUAGES
    lang = re.split(r"[-_]", (a.language or "").lower())[0]
    lang = lang if lang in LANGUAGES else None  # und、zxx 之类交给自动识别
    # 温度回退只留两档：默认六档在配乐多的片段上会把一个窗口反复重解码，耗时翻倍，结果也不更好
    r = mlx_whisper.transcribe(audio, path_or_hf_repo=model, language=lang, temperature=(0.0, 0.4),
                               initial_prompt="以下是普通话的句子，使用简体中文和标点。" if lang == "zh" else None,
                               condition_on_previous_text=False)
    lines = [t for t in (speech(seg, r.get("language") or lang) for seg in r["segments"]) if t]
    text = "\n".join(t for i, t in enumerate(lines) if i == 0 or t != lines[i - 1])  # 连续重复的同一句只留一次
    m = re.search(r"Duration: (\d+):(\d+):([\d.]+)", log)
    full = int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3]) if m else None
    if text and len(audio) >= (a.max_sec - 1) * 16000 and (full is None or full > a.max_sec + 1):
        text += f"\n（只转写了前 {a.max_sec // 60} 分钟，全长约 {round(full / 60)} 分钟）" if full else \
            f"\n（只转写了前 {a.max_sec // 60} 分钟，全长未知）"
    print(text)


if __name__ == "__main__":
    main()
