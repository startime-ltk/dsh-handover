/**
 * 用你机器上真实的会话文件跑一遍：解压 → 解析 → 裁摘要 → 渲染交接包。
 * 不依赖 DSH 宿主，验证的是"交接包对真实数据长什么样"。
 *
 * 用法: node scripts/try-real.mjs [会话文件名片段]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DEFAULT_BUDGET_CHARS, extractDigest, renderPack } from '../lib/core.js';

const ROOT = path.join(os.homedir(), '.dsh', 'sessions');

function findSessions(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findSessions(full, out);
    else if (entry.name.endsWith('.jsonl.zstd')) out.push(full);
  }
  return out;
}

const needle = process.argv[2] ?? '';
const all = findSessions(ROOT).filter((f) => f.includes(needle));
if (all.length === 0) {
  console.error('没找到会话文件，root =', ROOT);
  process.exit(1);
}

for (const file of all.sort()) {
  const raw = fs.readFileSync(file);
  let text;
  try {
    text = zlib.zstdDecompressSync(raw).toString('utf8');
  } catch (error) {
    console.error('解压失败', file, String(error?.message ?? error));
    continue;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 损坏行跳过 */
    }
  }

  const sessionId = path.basename(path.dirname(file));
  const sessionEvent = events.find((e) => e?.type === 'session') ?? {};
  const header = sessionEvent.data ?? sessionEvent;
  if (!header.cwd) console.log('（提示）没读到 cwd');
  const digest = extractDigest(events);
  const pack = renderPack({ digest, sessionId, cwd: header.cwd ?? null, budgetChars: DEFAULT_BUDGET_CHARS });

  const plainMb = (Buffer.byteLength(text) / 1048576).toFixed(2);
  console.log('='.repeat(78));
  console.log(`文件   ${path.relative(ROOT, file)}`);
  console.log(`明文   ${plainMb} MB / ${events.length} 条事件 / ${digest.turnCount} 轮`);
  console.log(
    `摘要   用户 ${digest.userTexts.length} 条、助手 ${digest.assistantTexts.length} 条、` +
      `写文件 ${digest.writes.length} 个、读文件 ${digest.reads.length} 个、待办 ${digest.todos.length} 项`,
  );
  console.log(`交接包 ${pack.length} 字（预算 ${DEFAULT_BUDGET_CHARS}）`);
  console.log('-'.repeat(78));
  console.log(pack);
}
