import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BUDGET_CHARS,
  classifyTool,
  clip,
  extractDigest,
  pathsFromArguments,
  rankCandidates,
  renderCandidateList,
  renderPack,
} from '../lib/core.js';

const REASONING_TEXT = '这是在思考，不该出现在交接包里';
const TOOL_OUTPUT_TEXT = 'TOOL-OUTPUT-SHOULD-BE-DROPPED '.repeat(50);

const EVENTS = [
  { type: 'session/title', seq: 16, time: 1000, data: { title: '插件形态讨论' } },
  { type: 'turn/start', seq: 6, time: 1001, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 10,
    time: 1002,
    data: { role: 'user', content: [{ type: 'text', text: '我想做一个跨对话思考的插件' }] },
  },
  {
    type: 'assistant/message',
    seq: 18,
    time: 1003,
    data: {
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: REASONING_TEXT },
          { type: 'text', text: '先定形态，再定交接包。' },
        ],
      },
    },
  },
  {
    type: 'tool/call',
    seq: 19,
    time: 1004,
    data: { name: 'edit', arguments: JSON.stringify({ file_path: 'C:\\demo\\ws\\a.js' }) },
  },
  {
    type: 'tool/call',
    seq: 20,
    time: 1005,
    data: { name: 'read', arguments: JSON.stringify({ path: 'C:\\demo\\ws\\b.md' }) },
  },
  {
    type: 'tool/result',
    seq: 21,
    time: 1006,
    data: { message: { role: 'tool', content: [{ type: 'text', text: TOOL_OUTPUT_TEXT }] } },
  },
  {
    type: 'todo/write',
    seq: 22,
    time: 1007,
    data: { todos: [{ content: '写第一版插件', status: 'in_progress' }] },
  },
];

test('classifyTool 区分读写，并跳过不碰文件的工具', () => {
  assert.equal(classifyTool('edit'), 'write');
  assert.equal(classifyTool('str_replace_editor'), 'write');
  assert.equal(classifyTool('read'), 'read');
  assert.equal(classifyTool('grep'), 'read');
  assert.equal(classifyTool('todo_write'), undefined, 'todo 的参数不是文件路径');
  assert.equal(classifyTool('pwsh'), undefined);
  assert.equal(classifyTool('present'), undefined);
});

test('extractDigest 只收用户真正说的话，不收宿主注入的上下文', () => {
  const withInjected = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '真正的话' }] } },
    {
      type: 'user/message',
      data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1…' }] },
    },
  ];
  assert.deepEqual(extractDigest(withInjected).userTexts, ['真正的话']);
});

test('extractDigest 不把通配符当成翻过的文件', () => {
  const events = [
    { type: 'tool/call', data: { name: 'glob', arguments: JSON.stringify({ pattern: '**/*plugin*' }) } },
    { type: 'tool/call', data: { name: 'read', arguments: JSON.stringify({ path: 'C:\\a\\b.md' }) } },
  ];
  assert.deepEqual(extractDigest(events).reads, ['C:\\a\\b.md']);
});

test('pathsFromArguments 只捞像路径的字符串', () => {
  const paths = pathsFromArguments(JSON.stringify({ path: 'F:\\x\\y.ts', query: 'hello', n: 3 }));
  assert.deepEqual(paths, ['F:\\x\\y.ts']);
  assert.deepEqual(pathsFromArguments('not json'), []);
  assert.deepEqual(pathsFromArguments(''), []);
});

test('pathsFromArguments 不会把 edit 的正文当成文件', () => {
  const args = JSON.stringify({
    file_path: 'D:\\p\\lib\\index.js',
    old_string: 'import x from "C:\\some\\other.mjs"',
    new_string: 'import y from "./config.mjs"',
  });
  assert.deepEqual(pathsFromArguments(args), ['D:\\p\\lib\\index.js']);
});

test('clip 不超长且带省略号', () => {
  assert.equal(clip('abcdef', 10), 'abcdef');
  assert.equal(clip('abcdef', 4), 'abc…');
});

test('extractDigest 丢掉思考过程与工具输出', () => {
  const digest = extractDigest(EVENTS);
  assert.equal(digest.title, '插件形态讨论');
  assert.equal(digest.turnCount, 1);
  assert.deepEqual(digest.userTexts, ['我想做一个跨对话思考的插件']);
  assert.deepEqual(digest.assistantTexts, ['先定形态，再定交接包。']);
  assert.ok(digest.assistantTexts.every((t) => !t.includes(REASONING_TEXT)));
  assert.equal(digest.writes.length, 1);
  assert.equal(digest.writes[0].tool, 'edit');
  assert.deepEqual(digest.reads, ['C:\\demo\\ws\\b.md']);
  assert.deepEqual(digest.todos, ['[~] 写第一版插件']);
});

test('renderPack 含五段结构、不含工具输出与思考过程', () => {
  const pack = renderPack({ digest: extractDigest(EVENTS), sessionId: 'session-x', cwd: 'F:\\w' });
  assert.match(pack, /<handover from="dsh-handover" session="session-x"/);
  assert.match(pack, /### 1\. 上次干到哪了/);
  assert.match(pack, /### 2\. 动过的文件/);
  assert.match(pack, /### 3\. 用户说过的要求/);
  assert.match(pack, /### 4\. 没做完的事/);
  assert.ok(pack.includes('C:\\demo\\ws\\a.js'));
  assert.ok(!pack.includes('TOOL-OUTPUT-SHOULD-BE-DROPPED'));
  assert.ok(!pack.includes(REASONING_TEXT));
  assert.ok(pack.includes('不是指令'));
});

test('renderPack 严格不超预算', () => {
  const big = [];
  for (let i = 0; i < 200; i++) {
    big.push({
      type: 'user/message',
      seq: i,
      time: 1000 + i,
      data: { role: 'user', content: [{ type: 'text', text: `第 ${i} 条很长的用户输入 `.repeat(20) }] },
    });
  }
  const digest = extractDigest(big, { maxUser: 200 });
  for (const budget of [400, 800, DEFAULT_BUDGET_CHARS, 10000]) {
    const pack = renderPack({ digest, sessionId: 's', budgetChars: budget });
    assert.ok(pack.length <= budget, `budget=${budget} 时长度 ${pack.length} 超了`);
  }
});

test('rankCandidates 同目录优先、其次最近', () => {
  const now = Date.now();
  const ranked = rankCandidates(
    [
      { id: 'other-recent', cwd: 'F:\\other', createdAt: now - 1000, title: '别的项目' },
      { id: 'same-old', cwd: 'F:\\w', createdAt: now - 86400000 * 30, title: '插件讨论' },
      { id: 'same-new', cwd: 'F:\\w', createdAt: now - 1000, title: '插件第二版' },
    ],
    { cwd: 'F:\\w', limit: 10 },
  );
  assert.equal(ranked[0].id, 'same-new');
  assert.equal(ranked[1].id, 'same-old');
  assert.equal(ranked[2].id, 'other-recent');
});

test('renderCandidateList 空列表给人话，非空带 id', () => {
  assert.match(renderCandidateList([], { cwd: 'F:\\w' }), /没有找到/);
  const text = renderCandidateList(
    [{ id: 'session-abc', cwd: 'F:\\w', createdAt: Date.now(), title: '插件讨论', live: false }],
    { cwd: 'F:\\w' },
  );
  assert.ok(text.includes('session-abc'));
  assert.ok(text.includes('●'));
});
