/**
 * listen.js — 把"视频里在说什么"接进来。
 *
 * ## 为什么需要它
 *
 * see-now 抓的是**屏幕**：`capture.js` 那条 ffmpeg 管道挂着 `-an`，一个音频字节都没有。
 * 所以模型看到的永远只有画面 —— 它不知道画面里的人在说什么、旁白讲到哪了。
 * `dsh-video-storyboard` 有 ASR，是因为它读的是文件、有音轨；实时看屏幕没有这条捷径。
 *
 * ## 这条链怎么分工
 *
 *    Python（examples/floating-chat/listen.py）
 *      WASAPI loopback 抓系统输出 → 16k 单声道 → 按静音断句 → `seg-<epochMs>.wav`
 *    Node（这里）
 *      扫目录取 wav → canonicalizeWav → 宿主 speechToText / 本地 HTTP → `{t0,t1,text}`
 *
 * 采集放 Python、转写放 Node，不是随手分的：
 *   - 抓回环只能走 pyaudiowpatch（PortAudio 官方不暴露 loopback 设备，实测 sounddevice
 *     的 WASAPI host API 里只有麦克风），那是 Python 包；
 *   - 宿主 `speechToText` 是 Node 侧的服务，只能在 Node 里调。
 *
 * ## 时间码为什么用 epoch 毫秒
 *
 * WASAPI loopback **静音时不推送数据**（实测 3 秒静音 callback 触发 0 次），
 * 样本数累加出来的时间是错的。而墙上时间是真实世界在走 —— 所以文件名里带
 * 段首的 epoch 毫秒，Node 侧拿它跟画面帧的 wall clock 对齐，中间静音多久都不漂。
 *
 * ## 部署（三级降级，永远不让"看屏幕"起不来）
 *
 *   1. 宿主 `speechToText`（DSH 桌面版自带 SenseVoice）—— 社区用户零安装
 *   2. `~/.dsh/asr.json` 指的 OpenAI 兼容服务（本地 :8000 那种）
 *   3. 都没有 → 不起 Python、不出字幕，`status` 里说明原因，看画面一切照旧
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seeNowHome } from './home.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const LISTEN_SCRIPT = join(HERE, '..', 'examples', 'floating-chat', 'listen.py');

/** 台词缓冲保留多久（毫秒）。看屏幕是长期会话，不修剪会一直涨。 */
const KEEP_MS = 180_000;
/** 连续失败几次就停（每 3 秒一句，坏一次不算坏，一直坏就别耗着了）。 */
const MAX_FAILS = 3;

/**
 * 把 ffmpeg/PortAudio 风格的 WAV 改写成宿主认的 **canonical** 形式。
 *
 * 宿主的 `validateWave()` 逐字节认死三条：`RIFF size === len - 8`、`data` 块
 * **必须正好在偏移 36**、`data size === len - 44`。而**管道写的 WAV 做不到前两条**
 * （长度回填不了，只能写 0xFFFFFFFF），ffmpeg 还会插一个 `LIST/INFO` 把 data 顶到 70。
 * 三条全灭 → 宿主抛 "Audio must be a canonical 16 kHz mono PCM16 WAV recording"，
 * 上层只看到一句 asr-failed，日志里毫无线索（2026-11-02 macOS 实报）。
 *
 * 这段和 `dsh-video-storyboard/src/storyboard/host-asr.js` 是同一套逻辑 ——
 * 两边都不想去依赖对方（see-now 对 storyboard 没有依赖），所以各自留一份。
 *
 * @param {Buffer|Uint8Array} input
 * @returns {Buffer} 44 字节头 + PCM
 */
export function canonicalizeWav(input) {
  const bytes = Buffer.isBuffer(input)
    ? input
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF'
    || bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV（缺 RIFF/WAVE 头）');
  }
  let p = 12;
  let fmt = null;
  let payload = null;
  while (p + 8 <= bytes.length) {
    const id = bytes.toString('latin1', p, p + 4);
    const size = bytes.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === 'data') {
      const end = size === 0xFFFFFFFF ? bytes.length : Math.min(bytes.length, body + size);
      payload = bytes.subarray(body, end - ((end - body) & 1));
      break;
    }
    if (id === 'fmt ' && size >= 16 && body + 16 <= bytes.length) fmt = bytes.subarray(body, body + 16);
    if (size === 0xFFFFFFFF || body + size > bytes.length) break;
    p = body + size + (size & 1);
  }
  if (!fmt) throw new Error('WAV 里没有 fmt 块');
  if (!payload) throw new Error('WAV 里没有 data 块');

  const out = Buffer.alloc(44 + payload.length);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVE', 8, 'latin1');
  out.write('fmt ', 12, 'latin1');
  out.writeUInt32LE(16, 16);
  fmt.copy(out, 20);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(payload.length, 40);
  payload.copy(out, 44);
  return out;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')) ?? {}; } catch { return {}; }
}

function dshHome(env = process.env) {
  return seeNowHome(env);
}

// ------------------------------------------------------------------ 转写

/**
 * 宿主 `speechToText` 适配器。取法和 storyboard 一致：`ctx.get(name)`，
 * **不能写 `ctx.speechToText`** —— cordis 对未声明的服务在 get 陷阱里直接抛，`?.` 挡不住。
 *
 * @returns {null | ((wav:Buffer) => Promise<string>)}
 */
export function hostTranscriber(ctx, { language = 'zh', timeoutMs = 30_000 } = {}) {
  let svc = null;
  try { svc = ctx?.get?.('speechToText') ?? null; } catch { svc = null; }
  if (!svc || typeof svc.resolve !== 'function' || typeof svc.transcribe !== 'function') return null;

  /** 模型不会因为"服务在"就自动加载；先 prepare 再等它 ready（最多 5 秒，等不到就直接试）。 */
  async function providerId() {
    if (typeof svc.snapshot !== 'function') return undefined;
    const id = svc.snapshot()?.selection?.providerId;
    if (!id) return undefined;
    const view = () => svc.snapshot()?.providers?.find((v) => v.id === id);
    const phase = () => view()?.preparation?.phase;
    if (!phase() || phase() === 'ready' || phase() === 'standby') return id;
    if (typeof svc.prepare !== 'function') return id;
    try { svc.prepare(id); } catch { return id; }
    const until = Date.now() + 5_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 150));
      const p = phase();
      if (p === 'ready' || p === 'standby' || p === 'failed') return id;
    }
    return id;
  }

  return async function viaHost(wav) {
    const id = await providerId();
    const spec = svc.resolve({
      audio: new Uint8Array(wav), language, ...(id ? { providerId: id } : {}),
    });
    const r = await svc.transcribe(spec, AbortSignal.timeout(timeoutMs));
    return String(r?.text ?? '').trim();
  };
}

/** `~/.dsh/asr.json`（和 storyboard 共用同一份配置）：`{baseUrl, key, model, language}` */
export function asrConfig(env = process.env) {
  const home = dshHome(env);
  const cfg = readJson(join(home, 'asr.json'));
  const baseUrl = env.DSH_ASR_BASE_URL || cfg.baseUrl || '';
  if (!baseUrl) return null;
  return {
    baseUrl: String(baseUrl).replace(/\/+$/, ''),
    key: env.DSH_ASR_KEY || cfg.key || '',
    model: env.DSH_ASR_MODEL || cfg.model || 'paraformer-zh-2024-03-09',
    language: env.DSH_ASR_LANGUAGE || cfg.language || 'zh',
  };
}

/** OpenAI 兼容 HTTP（see-now 自己不发请求给模型，只把音频丢给这个服务）。 */
export function httpTranscriber(cfg, { timeoutMs = 30_000, log = () => {} } = {}) {
  if (!cfg?.baseUrl) return null;
  return async function viaHttp(wav) {
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'a.wav');
    form.append('model', cfg.model);
    form.append('response_format', 'json');
    form.append('language', cfg.language || 'zh');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {},
        body: form,
        signal: ac.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}：${(await res.text()).slice(0, 120)}`);
      const j = await res.json();
      return String(j?.text ?? '').trim();
    } catch (e) {
      log(`转写失败：${e?.message ?? e}`);
      return '';
    } finally {
      clearTimeout(timer);
    }
  };
}

/** 选一个能用的转写器。宿主优先 —— 社区用户那边不用装任何东西。 */
export function resolveTranscriber(ctx, { env = process.env, log = () => {} } = {}) {
  const host = hostTranscriber(ctx);
  if (host) return { kind: 'host', transcribe: host, label: '宿主 SenseVoice' };
  const cfg = asrConfig(env);
  const http = httpTranscriber(cfg, { log });
  if (http) return { kind: 'http', transcribe: http, label: `本地 ${cfg.baseUrl}` };
  return null;
}

// ------------------------------------------------------------------ 静音窗口

/**
 * 静音窗口文件的路径。**默认和陪看共用同一个文件**（`$DSH_HOME/watch/out/quiet-until.json`）。
 *
 * 共用的理由：这个文件回答的是"这台机器上现在有没有人在念话"，跟是哪个插件在念无关。
 * 陪看的 `bin/watch.mjs` 写它（防两个 SAPI 抢话），`mic.py` 读它（防麦克风听见自己），
 * 我们两边都要 —— 写自己那份的话，麦克风那条就漏了。
 */
export function quietFile(env = process.env) {
  return env.DSH_QUIET_FILE || join(dshHome(env), 'watch', 'out', 'quiet-until.json');
}

/**
 * 占住静音窗口：告诉采集"接下来这几秒我在念，别听"。
 *
 * ⚠️ 这不是"屏蔽自己"，是**闭嘴不听** —— 窗口内整段音频直接丢，代价是：
 * 如果用户正好在这几秒说话、或者视频里正好有人在说台词，那一段也没了。
 *
 * 为什么不真做回声消除（AEC）：回环抓的是**系统混音后的成品**，AI 的声音和视频的声音
 * 在同一个信号里线性叠加，要减干净得知道它播出的每一个样本、确切时刻、以及系统音量与
 * 重采样链 —— 差一点就是减不干净的残差，而 ASR 对残差比对人声更敏感（会吐出更怪的句子）。
 * `aec.py` 那套是给麦克风用的（电信号 vs 空气传播，两条不同路径），套到回环上不成立。
 *
 * 真正的"只抓视频、不抓自己"要**按进程分轨**（Windows 的 process loopback），
 * 只能抓浏览器/播放器的音频树，AI 从别的进程出来的声音根本进不来。那是另一件事，
 * 要写 COM（`ActivateAudioInterfaceAsync`），pyaudiowpatch 没有这个能力。
 *
 * @returns {number|null} 静音到什么时候（epoch ms）
 */
export function markSpeaking(text, { env = process.env, extraMs = 1200 } = {}) {
  const chars = String(text ?? '').trim().length;
  if (!chars) return null;
  // 中文约 4~5 字/秒，取 4 再乘 1.5 倍余量，加收尾 —— **宁可多静音，也别把自己的话变成台词**
  const ms = Math.ceil((chars / 4) * 1000 * 1.5) + extraMs;
  const until = Date.now() + ms;
  try {
    const p = quietFile(env);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ until, at: Date.now(), by: 'see-now' }), 'utf8');
  } catch { /* 写不了最多是"可能听见自己"，别让它影响念 */ }
  return until;
}

// ------------------------------------------------------------------ Python

const PY_PROBE = 'import pyaudiowpatch, numpy';

/** 这个解释器有没有抓回环要的两个包（真跑一次 import，名字像没用）。 */
export function canListen(python) {
  const r = spawnSync(python, ['-c', PY_PROBE], { timeout: 8000, windowsHide: true, stdio: 'ignore' });
  return r?.status === 0;
}

/**
 * 找解释器。顺序：
 *   1. `DSH_SEE_PYTHON`（调试/临时）
 *   2. `~/.dsh/see-window.json` 的 `listenPython` / `python`
 *   3. PATH 上的 python3/python/pythonw（win32 顺序不同）
 *
 * 注意 **window.py 用的那个解释器未必有 pyaudiowpatch**（商店版 Python 往往没有），
 * 所以这里不看 tkinter，只看能不能 import。
 */
export function findListenPython({ env = process.env } = {}) {
  const cfg = readJson(join(dshHome(env), 'see-window.json'));
  const list = [
    env.DSH_SEE_PYTHON,
    cfg.listenPython,
    cfg.python,
    env.DSH_FLOAT_PYTHON,
    ...(process.platform === 'win32' ? ['python.exe', 'pythonw.exe'] : ['python3', 'python']),
  ].filter(Boolean);
  for (const py of [...new Set(list)]) {
    if (canListen(py)) return py;
  }
  return null;
}

// ------------------------------------------------------------------ 台词缓冲

/**
 * 台词缓冲。抽出来是为了可测 —— 时间窗过滤这种东西，靠"起个 Python 真录一段"
 * 是测不出边界（跨窗、超长、乱序）的。
 *
 * `t0/t1` 都是 epoch 毫秒。
 */
export function createLineBuffer({ keepMs = KEEP_MS } = {}) {
  let lines = [];
  return {
    add(t0, t1, text) {
      const t = String(text ?? '').trim();
      if (!t) return null;
      const entry = { t0, t1, text: t };
      lines.push(entry);
      // 修剪：只留最近 keepMs。看屏幕是长期会话，两三小时不修剪就是几千条
      if (lines.length > 8) {
        const cut = Date.now() - keepMs;
        lines = lines.filter((l) => l.t1 >= cut);
      }
      return entry;
    },
    /**
     * 取某段时间窗里的台词。**窗口按相交算**（`l.t1 >= from && l.t0 <= to`），
     * 跨窗的那句两边都算 —— 宁可让模型看到同一句两次（它只会觉得啰嗦），
     * 也不要漏掉（漏了它就完全不知道这段说了什么）。
     *
     * 超长时**从新往旧丢**：最近的话更相关。
     */
    between(fromMs, toMs, { maxChars = 1200 } = {}) {
      if (!lines.length) return [];
      const out = [];
      let chars = 0;
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const l = lines[i];
        if (l.t1 < fromMs || l.t0 > toMs) continue;
        if (chars + l.text.length > maxChars && out.length) break;
        out.push(l);
        chars += l.text.length;
      }
      return out.reverse();
    },
    get size() { return lines.length; },
    get all() { return lines.slice(); },
  };
}

// ------------------------------------------------------------------ 主体

/**
 * @param {object} o
 * @param {object|null} o.ctx        宿主 ctx（取 speechToText）
 * @param {string} [o.dir]           wav 落盘目录（默认 `~/.dsh/see-now/audio`）
 * @param {string} [o.python]        解释器（默认自动找）
 * @param {string} [o.script]        listen.py（默认包内那份）
 * @param {NodeJS.ProcessEnv} [o.env]
 */
export function createListener({
  ctx = null, dir = null, python = null, script = LISTEN_SCRIPT,
  // 200ms：这个轮询直接计进"说完到模型能看见"的延迟里（见 README 的延迟分解）。
  // 再快意义不大 —— 下面静音判定那 450ms 才是大头。
  env = process.env, log = () => {}, pollMs = 200,
} = {}) {
  const audioDir = dir || join(dshHome(env), 'see-now', 'audio');
  const buffer = createLineBuffer();
  let child = null;
  let timer = null;
  let busy = false;
  let fails = 0;
  let enabled = false;
  let reason = '没启动';
  let transcriber = null;
  let lastSegAt = 0;
  let total = 0;

  function state() {
    return {
      enabled,
      reason,
      backend: transcriber?.label ?? null,
      python: python ?? null,
      dir: audioDir,
      lines: buffer.size,
      total,
      lastSegAt: lastSegAt || null,
    };
  }

  /** 扫目录，处理没见过的 wav。一次一条，串行 —— 并发打同一个模型只会互相排队。 */
  async function drain() {
    if (busy || !transcriber) return;
    busy = true;
    try {
      let names = [];
      try { names = readdirSync(audioDir); } catch { names = []; }
      const segs = names
        .filter((n) => /^seg-\d+\.wav$/.test(n))
        .sort((a, b) => Number(a.slice(4, -4)) - Number(b.slice(4, -4)));
      if (env.DSH_SEE_NOW_DEBUG) log(`[listen] drain: 目录里 ${names.length} 个文件，待处理 ${segs.length}`);
      for (const name of segs) {
        const path = join(audioDir, name);
        let wav = null;
        try {
          // Python 侧是「写 .tmp 再 rename」，所以这里看到的都是完整的；
          // 但如果是老版本/被手动塞进来的，size 为 0 就跳过，别拿去转写。
          if (statSync(path).size < 1024) continue;
          wav = readFileSync(path);
        } catch { continue; }
        const t0 = Number(name.slice(4, -4));
        let text = '';
        try {
          text = await transcriber.transcribe(canonicalizeWav(wav));
          fails = 0;
        } catch (e) {
          fails += 1;
          log(`转写出错（${fails}/${MAX_FAILS}）：${e?.message ?? e}`);
          if (fails >= MAX_FAILS) {
            stop(`连续 ${MAX_FAILS} 次转写失败`);
            return;
          }
        }
        // 处理完就删：目录是工作区，不是档案。留着会几小时涨到几千个文件。
        try { unlinkSync(path); } catch { /* 删不掉就下次再说 */ }
        if (!text) continue;
        const dur = Math.max(0.2, (wav.length - 44) / 2 / 16_000);
        buffer.add(t0, t0 + Math.round(dur * 1000), text);
        lastSegAt = Date.now();
        total += 1;
      }
    } finally {
      busy = false;
    }
  }

  /**
   * 起采集。**幂等**，失败只记状态不抛 —— 音频是加分项，装不上最多没字幕。
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function start() {
    if (child) return { ok: true, reason: 'already' };
    if (env.DSH_SEE_AUDIO === '0') {
      reason = '被 DSH_SEE_AUDIO=0 关掉了';
      enabled = false;
      return { ok: false, reason };
    }
    transcriber = resolveTranscriber(ctx, { env, log });
    if (!transcriber) {
      reason = '没有可用的转写服务（宿主没有 speechToText，也没有 ~/.dsh/asr.json）';
      enabled = false;
      return { ok: false, reason };
    }
    if (!existsSync(script)) {
      reason = `找不到 listen.py（${script}）`;
      enabled = false;
      return { ok: false, reason };
    }
    python ??= findListenPython({ env });
    if (!python) {
      reason = '没有能用的 Python（要 `pip install pyaudiowpatch numpy`，'
        + '或把解释器路径写进 ~/.dsh/see-window.json 的 listenPython）';
      enabled = false;
      return { ok: false, reason };
    }

    mkdirSync(audioDir, { recursive: true });
    try {
      child = spawn(python, [script, '--out', audioDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...env, DSH_VIDEO_CACHE_DIR: join(dshHome(env), 'see-now') },
      });
    } catch (e) {
      reason = `起不来：${e?.message ?? e}`;
      enabled = false;
      child = null;
      return { ok: false, reason };
    }

    child.stdout?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(0, 400)}`);
    });
    child.stderr?.on('data', (d) => {
      const s = String(d).trim();
      if (s) log(`[listen] ${s.slice(-400)}`);
    });
    child.on('exit', (code) => {
      const wasEnabled = enabled;
      child = null;
      enabled = false;
      if (timer) { clearInterval(timer); timer = null; }
      if (wasEnabled) {
        reason = `采集进程退出了（code=${code}）`;
        log(reason);
      }
    });

    // 等它把设备打开：不确认就报"在听"，用户会以为功能开了其实一句都没录（踩过）
    const ok = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(null), 4000);
      const onData = (d) => {
        if (!String(d).includes('"event": "device"')) return;
        clearTimeout(t);
        child?.stdout?.off('data', onData);
        resolve(true);
      };
      child?.stdout?.on('data', onData);
      child?.once('exit', () => { clearTimeout(t); resolve(false); });
    });
    if (!ok) {
      stop('回环设备没打开（没有可用的 WASAPI loopback？）');
      reason = '回环设备没打开 —— 这台机器抓不到系统输出的声音';
      return { ok: false, reason };
    }

    enabled = true;
    reason = '在听';
    timer = setInterval(() => {
      // 这里**不能静默吞**：drain 里的意外（权限、编码、表单构造）如果被 `.catch(() => {})`
      // 吃掉，表现就是"在听、但永远没台词"，日志里一条线索都没有。
      drain().catch((e) => log(`[listen] drain 出错：${e?.message ?? e}`));
    }, pollMs);
    timer.unref?.();
    return { ok: true };
  }

  function stop(why = null) {
    if (timer) { clearInterval(timer); timer = null; }
    if (child) {
      try { child.kill(); } catch { /* 已经没了 */ }
      child = null;
    }
    enabled = false;
    reason = why || '停了';
  }

  /**
   * 取某段时间窗里的台词（见 `createLineBuffer().between`）。
   */
  function between(fromMs, toMs, opts) {
    return buffer.between(fromMs, toMs, opts);
  }

  return { start, stop, state, between, drain };
}
