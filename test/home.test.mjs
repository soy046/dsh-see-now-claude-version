import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { resolveFfmpeg } from '../src/binaries.js';
import { chatDir } from '../src/chat.js';
import { seeNowHome } from '../src/home.js';

test('SEE_NOW_HOME 优先于 DSH_HOME', () => {
  assert.equal(
    seeNowHome({ SEE_NOW_HOME: 'C:/see-now', DSH_HOME: 'C:/dsh' }),
    'C:/see-now',
  );
});

test('只有 DSH_HOME 时用它', () => {
  assert.equal(seeNowHome({ DSH_HOME: 'C:/dsh' }), 'C:/dsh');
});

test('都没有时用 USERPROFILE/.dsh', () => {
  assert.equal(seeNowHome({ USERPROFILE: 'C:/Users/me' }), join('C:/Users/me', '.dsh'));
});

test('没有 USERPROFILE 时用 HOME/.dsh', () => {
  assert.equal(seeNowHome({ HOME: '/home/me' }), join('/home/me', '.dsh'));
});

test('chatDir 走 SEE_NOW_HOME', () => {
  assert.equal(chatDir({ SEE_NOW_HOME: 'C:/see-now' }), join('C:/see-now', 'see-now'));
});

test('resolveFfmpeg 在 SEE_NOW_HOME 下找 tools/ffmpeg/bin', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'see-now-home-'));
  const bin = join(tmp, 'tools', 'ffmpeg', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'ffmpeg.exe'), '');

  const r = resolveFfmpeg({ env: { SEE_NOW_HOME: tmp }, platform: 'win32' });
  assert.equal(r.path, join(bin, 'ffmpeg.exe'));
});
