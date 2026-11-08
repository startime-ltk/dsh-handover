/**
 * 离线集成冒烟：不启动 DSH，用假的 ctx / sessionQuery 加载真插件，
 * 把「注册工具 → list → pack」整条链路跑一遍，数据用你机器上的真实会话。
 *
 * 用法: node scripts/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import * as plugin from '../lib/index.js';

const ROOT = path.join(os.homedir(), '.dsh', 'sessions');
const CALLER = { id: 'session-caller-current', cwd: path.join(os.homedir(), 'demo-workspace') };

function findSessions(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSessions(full, out);
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(full);
  }
  return out;
}

function loadSession(file) {
  const text = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  const first = events.find((e) => e?.type === 'session') ?? {};
  const id = path.basename(path.dirname(file));
  return {
    id,
    session: { id, cwd: first.cwd ?? null, createdAt: first.createdAt },
    events,
    title: events.find((e) => e?.type === 'session/title')?.data?.title ?? null,
  };
}

const loaded = findSessions(ROOT)
  .map(loadSession)
  .filter((s) => s.events.length > 10)
  .sort((a, b) => (b.session.createdAt ?? 0) - (a.session.createdAt ?? 0));

if (loaded.length === 0) {
  console.error('没有可用的真实会话，root =', ROOT);
  process.exit(1);
}
console.log(`载入真实会话 ${loaded.length} 个：`);
for (const s of loaded) console.log(`  - ${s.id}  cwd=${s.session.cwd}  ${s.events.length} 条事件`);
console.log('');

const registered = [];
const fakeCtx = {
  tools: { register: (definition) => registered.push(definition) },
  sessionQuery: {
    async listSessions() {
      return loaded.map((s) => ({ header: s.session, live: false, persisted: true }));
    },
    async readTitleSnapshots(ids) {
      return ids.map((id) => {
        const hit = loaded.find((s) => s.id === id);
        return {
          sessionId: id,
          status: 'ok',
          value: { session: { id }, title: hit?.title ? { title: hit.title } : null },
        };
      });
    },
    async readSession(id) {
      const hit = loaded.find((s) => s.id === id);
      if (!hit) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND: ' + id);
      return { session: hit.session, inheritedEventCount: 0, events: hit.events };
    },
  },
};

plugin.apply(fakeCtx, { maxCandidates: 20, budgetChars: 3000 });
console.log(`apply() 注册了 ${registered.length} 个工具：${registered.map((d) => d.name).join(', ')}`);
if (registered.length !== 1) {
  console.error('期望恰好注册 1 个工具');
  process.exit(1);
}
const tool = registered[0];
console.log(`参数 schema：${Object.keys(tool.parameters?.properties ?? {}).join(', ')}`);
console.log('');

const exec = { agent: { session: { id: CALLER.id, header: { cwd: CALLER.cwd } } }, signal: undefined };

console.log('=== action=list ===');
const listText = String(await tool.execute({ action: 'list', keywords: '插件' }, exec));
console.log(listText.split('\n').slice(0, 14).join('\n'));
console.log(`…（共 ${listText.split('\n').length} 行）`);
console.log('');

console.log('=== action=pack（挑最新的那个）===');
const target = loaded[0];
const packText = String(await tool.execute({ action: 'pack', sessions: [target.id], budget: 3000 }, exec));
const lines = packText.split('\n');
console.log(lines.slice(0, 20).join('\n'));
console.log(`…（共 ${lines.length} 行 / ${packText.length} 字）`);
console.log('');

console.log('=== 边界 ===');
console.log('不给 sessions :', String(await tool.execute({ action: 'pack' }, exec)).slice(0, 70));
console.log('不存在的 id   :', String(await tool.execute({ action: 'pack', sessions: ['session-nope'] }, exec)).split('\n')[0]);
const selfText = String(await tool.execute({ action: 'pack', sessions: [CALLER.id] }, exec));
console.log('指向当前会话   :', selfText.split('\n').slice(0, 2).join(' | '));
console.log('');
console.log('冒烟通过。');
