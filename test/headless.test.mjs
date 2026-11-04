/**
 * headless.test.mjs — MCP server 用的无窗模式回归。
 *
 * MCP server 那边没有悬浮窗、没有窗口聊天、也没有声音，只做「采集 → 打包」。
 * 所以 `headless: true` 必须：不弹窗、不写 pid 文件、不读聊天通道、不起音频监听；
 * 同时出图这条路一点不能少。
 *
 * 用 `source:"file"` 喂合成视频，和线上同一条采集路径，只是把屏幕换成文件。
 * 需要 ffmpeg 在 PATH 上；没有就跳过第三条（前两条不需要 ffmpeg）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 必须在 import 之前：pid 文件 / 聊天目录都按这个 home 落盘
const HOME_DIR = mkdtempSync(join(tmpdir(), 'dsh-see-headless-'));
process.env.SEE_NOW_HOME = HOME_DIR;
// 刻意不设 DSH_SEE_NO_WINDOW：要证明的是 headless 自己就不会碰窗，而不是靠环境变量挡住

const FIXTURE = join('.tmp', 'headless-clip.mp4');

function ffmpegOk() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function makeFixture() {
  if (existsSync(FIXTURE) && statSync(FIXTURE).size > 10_000) return FIXTURE;
  mkdirSync('.tmp', { recursive: true });
  // testsrc2 一直在动 → 能攒出真正的画面
  execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=12', '-t', '10',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', FIXTURE], { stdio: 'inherit' });
  return FIXTURE;
}

const skip = !ffmpegOk();
const { createRunner } = await import('../src/runner.js');

test('headless 的 status：headless=true，听声音关着且说明原因', () => {
  const st = createRunner({ headless: true }).status();
  assert.equal(st.headless, true);
  assert.equal(st.listen.enabled, false);
  assert.equal(st.listen.reason, 'headless');
});

test('默认不是 headless', () => {
  assert.equal(createRunner().status().headless, false);
});

test('headless watch 不弹窗、不写 pid 文件，照样能出图', { skip }, async () => {
  const runner = createRunner({ headless: true });
  try {
    const r = await runner.watch({
      src: { kind: 'file', path: makeFixture() },
      seconds: 20,
    });
    assert.equal(r.ok, true, `应能出图，实际：${JSON.stringify(r).slice(0, 200)}`);

    const st = runner.status();
    assert.equal(st.window.reason, 'headless', '没开窗要说清楚是 headless，而不是"开失败了"');
    assert.equal(st.windowOpened, false, 'headless 不该有任何"窗开过"的记录');
    assert.equal(
      existsSync(join(HOME_DIR, 'see-now-window.pid')), false,
      'headless 绝不能留下 see-now-window.pid',
    );
  } finally {
    runner.stop();
  }
});
