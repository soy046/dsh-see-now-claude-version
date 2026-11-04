import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// **必须赶在 import mcp.js 之前换掉 HOME**：region.js 的 loadRegion/clearRegion 读的是
// SEE_NOW_HOME 下的文件，不换就会去碰用户真实的 ~/.dsh。
process.env.SEE_NOW_HOME = mkdtempSync(join(tmpdir(), 'see-now-mcp-'));

const { createSeeNowServer } = await import('../src/mcp.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

const FAKE_SHEET = {
  png: Buffer.from('fakepng'),
  frames: [{ t: 1, tier: 2, via: 'cut' }, { t: 3, tier: 2, via: 'cut' }],
  from: 1,
  to: 3,
  fill: 0.5,
  why: 'full',
  w: 800,
  h: 450,
  cells: [{ pw: 400, ph: 225 }, { pw: 400, ph: 225 }],
};

const FAKE_STATUS = {
  running: false,
  idleSec: 0,
  lastError: null,
  pending: 0,
  sheets: 0,
  lastSource: null,
  headless: true,
};

function fakeRunner(script = {}) {
  const calls = [];
  return {
    calls,
    async watch(args) {
      calls.push({ method: 'watch', args });
      return script.watch ?? { ok: true, sheet: FAKE_SHEET, waited: 12, partial: false };
    },
    peek() {
      calls.push({ method: 'peek' });
      return script.peek ?? null;
    },
    async start(args) {
      calls.push({ method: 'start', args });
      return script.start ?? { started: true, source: { kind: 'screen' }, engine: 'gdigrab' };
    },
    stop() {
      calls.push({ method: 'stop' });
      return { stopped: true };
    },
    status() {
      calls.push({ method: 'status' });
      return script.status ?? FAKE_STATUS;
    },
  };
}

/** 建一个连上内存 transport 的 server + client。 */
async function setup(script = {}) {
  const runner = fakeRunner(script);
  const server = createSeeNowServer({ runner });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'mcp-test', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    runner,
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function call(client, args = {}) {
  return client.callTool({ name: 'see_now', arguments: args });
}

/** 结果里所有 text block 拼起来（图像结果通常是第 2 块）。 */
function textOf(res) {
  return (res.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
}

test('listTools: 只有一个 see_now，参数正好十个', async () => {
  const { client, close } = await setup();
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'see_now');
    assert.deepEqual(
      Object.keys(tools[0].inputSchema.properties).sort(),
      ['action', 'minFrames', 'pace', 'path', 'quality', 'realtime', 'region', 'scene', 'seconds', 'source'],
    );
  } finally {
    await close();
  }
});

test('watch 成功：image block + 文字清单', async () => {
  const { client, close } = await setup();
  try {
    const res = await call(client, {});
    assert.ok(!res.isError);
    assert.equal(res.content[0].type, 'image');
    assert.equal(res.content[0].mimeType, 'image/png');
    assert.equal(res.content[0].data, Buffer.from('fakepng').toString('base64'));
    assert.equal(res.content[1].type, 'text');
    assert.match(res.content[1].text, /2 个画面/);
  } finally {
    await close();
  }
});

test('watch: seconds 封顶 860，默认 300，signal 是 AbortSignal', async () => {
  const first = await setup();
  try {
    await call(first.client, { seconds: 5000 });
    const w = first.runner.calls.find((c) => c.method === 'watch');
    assert.equal(w.args.seconds, 860);
    assert.ok(w.args.signal instanceof AbortSignal);
  } finally {
    await first.close();
  }

  const second = await setup();
  try {
    await call(second.client, {});
    const w = second.runner.calls.find((c) => c.method === 'watch');
    assert.equal(w.args.seconds, 300);
  } finally {
    await second.close();
  }
});

test('watch no-change：不是错误，提示画面没变', async () => {
  const { client, close } = await setup({
    watch: { ok: false, reason: 'no-change', waited: 30 },
  });
  try {
    const res = await call(client, {});
    assert.ok(!res.isError);
    assert.match(textOf(res), /画面基本没变/);
  } finally {
    await close();
  }
});

test('watch region 格式不对：isError，且不调 runner.watch', async () => {
  const { runner, client, close } = await setup();
  try {
    const res = await call(client, { region: 'abc' });
    assert.ok(res.isError);
    assert.equal(runner.calls.some((c) => c.method === 'watch'), false);
  } finally {
    await close();
  }
});

test('watch 采集停了：isError', async () => {
  const { client, close } = await setup({
    watch: { ok: false, reason: 'capture-stopped', waited: 1, error: 'x' },
  });
  try {
    const res = await call(client, {});
    assert.ok(res.isError);
    assert.match(textOf(res), /capture-stopped/);
  } finally {
    await close();
  }
});

test('pace calm：stop 一次，说明只带一轮', async () => {
  const { runner, client, close } = await setup();
  try {
    const res = await call(client, { pace: 'calm' });
    assert.equal(runner.calls.filter((c) => c.method === 'stop').length, 1);
    assert.ok(textOf(res).startsWith('已切到**省电节奏**'), textOf(res));

    const next = await call(client, { action: 'peek' });
    assert.doesNotMatch(textOf(next), /省电节奏/);
  } finally {
    await close();
  }
});

test('peek：空 / 有图两种结果', async () => {
  const empty = await setup({ peek: null });
  try {
    const res = await call(empty.client, { action: 'peek' });
    assert.ok(!res.isError);
    assert.match(textOf(res), /还没有攒好/);
  } finally {
    await empty.close();
  }

  const full = await setup({ peek: FAKE_SHEET });
  try {
    const res = await call(full.client, { action: 'peek' });
    assert.ok(!res.isError);
    assert.equal(res.content[0].type, 'image');
    assert.equal(res.content[0].mimeType, 'image/png');
  } finally {
    await full.close();
  }
});

test('未知 action：isError', async () => {
  const { client, close } = await setup();
  try {
    const res = await call(client, { action: 'fly' });
    assert.ok(res.isError);
  } finally {
    await close();
  }
});

test('status：不是错误，带模式和队列', async () => {
  const { client, close } = await setup();
  try {
    const res = await call(client, { action: 'status' });
    assert.ok(!res.isError);
    assert.match(textOf(res), /模式：/);
  } finally {
    await close();
  }
});

test('region off：不是错误，回到整屏', async () => {
  const { client, close } = await setup();
  try {
    const res = await call(client, { action: 'region', region: 'off' });
    assert.ok(!res.isError);
    assert.match(textOf(res), /整屏/);
  } finally {
    await close();
  }
});
