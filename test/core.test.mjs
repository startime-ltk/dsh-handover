import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_BUDGET_CHARS,
  classifyTool,
  clip,
  clipSentence,
  extractDigest,
  extractShellCommand,
  isStateChangingCommand,
  pathsFromArguments,
  pickProgressTexts,
  rankCandidates,
  renderCandidateList,
  renderEventWindow,
  renderPack,
  renderSearchResults,
  scanEvents,
  selectUserLines,
  similarity,
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

// —— 0.1.1 修的 bug 的回归测试 ——

test('classifyTool 不再把 create_goal / create_worktree 当成写文件', () => {
  assert.equal(classifyTool('create_goal'), undefined);
  assert.equal(classifyTool('create_worktree'), undefined);
  assert.equal(classifyTool('todo_write'), undefined);
  assert.equal(classifyTool('mcp__fs__write'), 'write');
  assert.equal(classifyTool('str_replace_editor'), 'write');
});

test('pathsFromArguments 不做全文泛扫，目标描述里的路径不算改动', () => {
  // create_goal 的参数是一大段自然语言，里面有路径也不该被记成"动过的文件"
  const args = JSON.stringify({ objective: '把 C:\\demo\\ws\\a.js 和 D:\\x\\b.md 合并' });
  assert.deepEqual(pathsFromArguments(args), []);
});

test('clipSentence 在句末标点收尾，不切半句', () => {
  const text = '第一句结论。第二句补充说明。第三句很长的内容'.repeat(3);
  const out = clipSentence(text, 40);
  assert.ok(out.length <= 40, `长度 ${out.length} 超了`);
  assert.ok(/[。！？；]$/.test(out), `没有停在句末标点：${JSON.stringify(out)}`);
});

test('similarity 能识别同一结论的两次表述', () => {
  const a = '没有可装的东西：registry 上只有 331 字节的占位包，没有 1.1.71。';
  const b = '结论不变：registry 上只有 331 字节的占位包，没有 1.1.71 版本。';
  assert.ok(similarity(a, b) > 0.6, `相似度只有 ${similarity(a, b).toFixed(2)}`);
});

test('pickProgressTexts 默认只取 1 条实质正文', () => {
  const long = '这是一段足够长的结论正文。'.repeat(8);
  const another = '另一段也很长的内容，讲的是不同的事情。'.repeat(8);

  // 默认 maxCount=1：长会话里两条必然语义重复，只留最后一条
  assert.equal(pickProgressTexts([long, another]).length, 1);
  assert.deepEqual(pickProgressTexts([long, another]), [another]);

  // 末尾的极短回复（"好的。"）要被跳过，取前面有实质内容的
  assert.deepEqual(pickProgressTexts([long, '好的。']), [long]);

  // 显式要 2 条时才回 2 条（且近似重复会被兜掉）
  assert.equal(pickProgressTexts([long, another], { maxCount: 2 }).length, 2);
});

test('交接包头部与正文之间有空行，不糊在一起', () => {
  const pack = renderPack({ digest: extractDigest(EVENTS), sessionId: 's' });
  assert.match(pack, /工作目录：[^\n]*\n\n### 1\./, '工作目录后面应有一个空行');
});

// —— 0.2.0 新能力 ——

test('extractShellCommand 从 shell 工具参数里取命令行', () => {
  assert.equal(extractShellCommand(JSON.stringify({ command: 'git   status' })), 'git status');
  assert.equal(extractShellCommand(JSON.stringify({ script: 'npm install' })), 'npm install');
  assert.equal(extractShellCommand(JSON.stringify({ other: 1 })), null);
  assert.equal(extractShellCommand('不是 JSON'), null);
});

test('isStateChangingCommand 只认会改变状态的命令', () => {
  assert.equal(isStateChangingCommand('git commit -m "x"'), true);
  assert.equal(isStateChangingCommand('npm install'), true);
  assert.equal(isStateChangingCommand('Remove-Item -Recurse .tmp'), true);
  assert.equal(isStateChangingCommand('Get-ChildItem -Force'), false);
  assert.equal(isStateChangingCommand('grep -r foo .'), false);
});

test('extractDigest 记录跑过的关键命令，忽略只读命令', () => {
  const events = [
    { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: 'Get-ChildItem' }) } },
    { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: 'git commit -m "feat"' }) } },
    { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command: 'npm install' }) } },
  ];
  const digest = extractDigest(events);
  assert.deepEqual(digest.commands, ['git commit -m "feat"', 'npm install']);
});

test('extractDigest 判断上次是否正常结束', () => {
  const interrupted = extractDigest([{ type: 'turn/start', data: { turn: 1 } }]);
  assert.equal(interrupted.completed, false, '有 turn/start 没有 turn/end = 被打断');

  const finished = extractDigest([
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ]);
  assert.equal(finished.completed, true);

  assert.equal(extractDigest([]).completed, null, '没有轮次信息时不做判断');
});

test('交接包会提示"上次没正常结束"', () => {
  const events = [...EVENTS, { type: 'turn/start', data: { turn: 99 } }];
  const pack = renderPack({ digest: extractDigest(events), sessionId: 's' });
  assert.match(pack, /没有正常结束/);
});

test('selectUserLines 保住最早的硬约束', () => {
  const texts = [
    '安装到 D 盘，插件单独一个文件夹，先不要做，先告诉我有什么问题',
    '好',
    ...Array.from({ length: 20 }, (_, i) => `第 ${i + 3} 条普通要求`),
  ];
  const lines = selectUserLines(texts, { early: 3, late: 9 });
  assert.ok(
    lines.some((l) => l.includes('先不要做')),
    '最早的约束必须还在',
  );
  assert.ok(lines.some((l) => /省略 \d+ 条用户消息/.test(l)), '中间要有省略标注');
  assert.ok(lines.length <= 3 + 9 + 1);
});

test('scanEvents 能按关键词找到带 seq 的片段', () => {
  const events = [
    { type: 'user/message', seq: 10, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '安装 purge 1.1.71' }] } },
    { type: 'assistant/message', seq: 18, time: 2000, data: { message: { content: [{ type: 'text', text: 'registry 上只有占位包，没有 1.1.71' }] } } },
    { type: 'tool/result', seq: 22, time: 3000, data: { message: { content: [{ type: 'text', text: 'npm error 404 purgg' }] } } },
    { type: 'user/message', seq: 30, time: 4000, data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '注入的上下文里也提到 1.1.71' }] } },
  ];
  const hits = scanEvents(events, '1.1.71');
  assert.equal(hits.length, 2, '宿主注入的上下文不参与检索');
  assert.deepEqual(
    hits.map((h) => h.seq),
    [10, 18],
  );
  assert.equal(hits[0].role, 'user');
  assert.ok(hits[1].snippet.includes('占位包'));

  assert.equal(scanEvents(events, '1.1.71 占位包').length, 1, '多个词要求全部命中');
  assert.equal(scanEvents(events, '').length, 0);
});

test('renderSearchResults 给出可用的 seq 和下一步提示', () => {
  const text = renderSearchResults(
    [{ seq: 18, time: 2000, type: 'assistant/message', role: 'assistant', snippet: '…占位包…', chars: 30 }],
    { query: '占位包', sessionId: 'session-abc' },
  );
  assert.ok(text.includes('seq 18'));
  assert.ok(text.includes('action: "read"'));
  assert.match(renderSearchResults([], { query: 'x', sessionId: 'session-abc' }), /没有找到/);
});

test('renderEventWindow 按 seq 取原文并标出目标', () => {
  const events = [
    { type: 'user/message', seq: 10, time: 1000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一条' }] } },
    { type: 'assistant/message', seq: 18, time: 2000, data: { message: { content: [{ type: 'text', text: '目标这条的原文' }] } } },
    { type: 'user/message', seq: 30, time: 3000, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第三条' }] } },
  ];
  const text = renderEventWindow(events, { seq: 18, before: 1, after: 1 });
  assert.ok(text.includes('目标这条的原文'));
  assert.ok(text.includes('← 你要的'));
  assert.ok(text.includes('第一条'), 'before=1 应带上前一条');
  assert.ok(text.includes('第三条'), 'after=1 应带上后一条');
  assert.match(renderEventWindow(events, { seq: 999 }), /没有 seq=999/);
});

test('renderPack 极小预算也保留闭合标签，不产出畸形 XML', () => {
  const digest = extractDigest(EVENTS);
  for (const budget of [400, 420, 460]) {
    const pack = renderPack({ digest, sessionId: 's', budgetChars: budget });
    assert.ok(pack.length <= budget, `budget=${budget} 长度 ${pack.length}`);
    assert.ok(pack.trimEnd().endsWith('</handover>'), `budget=${budget} 闭合标签被截掉了`);
    assert.ok(pack.startsWith('<handover'), '开标签丢了');
  }
});

test('renderPack 正文超预算时丢整段而不是切断段落', () => {
  const crowded = [];
  for (let i = 0; i < 40; i++) {
    crowded.push({
      type: 'tool/call',
      data: { name: 'edit', arguments: JSON.stringify({ file_path: `C:\\p\\f${i}.js` }) },
    });
    crowded.push({
      type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 条要求，请处理一下。` }] },
    });
  }
  const pack = renderPack({ digest: extractDigest(crowded), sessionId: 's', budgetChars: 1200 });
  assert.ok(pack.length <= 1200);
  assert.ok(pack.trimEnd().endsWith('</handover>'));
  // 丢段时会给提示，不会静默少内容
  if (pack.includes('省略')) assert.match(pack, /省略 \d+ 个小段/);
});
