/**
 * dsh-handover —— 跨会话交接
 *
 * 只做一件事：把旧会话压成一份"交接包"交给当前会话的模型，让它接着干活。
 *
 * 硬约束：旧会话只读。本插件只调用 ctx.sessionQuery 的读取方法，
 * 从不 append、不 resume、不把旧会话变成 live。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  DEFAULT_BUDGET_CHARS,
  clip,
  extractDigest,
  rankCandidates,
  renderCandidateList,
  renderEventWindow,
  renderPack,
  renderSearchResults,
  scanEvents,
} from './core.js';

/** Cordis 插件名，供 loader 诊断用。 */
export const name = 'dsh-handover';

/** 依赖的能力服务。 */
export const inject = ['tools', 'sessionQuery'];

const DESCRIPTION = [
  '跨会话交接：把旧会话压成交接包（进度 / 动过的文件 / 跑过的命令 / 用户要求 / 待办），让当前会话接着干活。旧会话全程只读，不会被修改或唤醒。',
  '当用户说"接着上次那个会话干""交接一下""继续昨天那件事"时使用。',
  '流程：先 action="list" 拿候选会话 id，再把用户选中的 id 传给 action="pack"。',
  '交接包只是摘要。用户中途问起包里没有的细节时，用 action="search" 在那个旧会话里按关键词查，再用 action="read" 按 seq 取原文。',
  '不要用它读取当前正在对话的这个会话。',
].join('');

/** search 时如果没有指定会话，最多扫几个同目录会话。 */
const SEARCH_SESSION_LIMIT = 8;
/** search 结果的总字数上限，防止一次查爆上下文。 */
const SEARCH_OUTPUT_LIMIT = 4000;

/** 组装交接包时的固定开销（用法提醒、跳过说明等）。 */
const ASSEMBLY_OVERHEAD = 200;

/**
 * 从会话查询返回的记录里稳定地取出字段，兼容 header 嵌套与否。
 * @param {any} record 查询记录
 * @returns {{ id: string, cwd: string|null, createdAt: number|undefined, live: boolean|undefined, persisted: boolean|undefined }}
 */
function readRecord(record) {
  const header = record?.header ?? record ?? {};
  return {
    id: String(header.id ?? record?.id ?? ''),
    cwd: header.cwd ?? null,
    createdAt: typeof header.createdAt === 'number' ? header.createdAt : undefined,
    live: record?.live ?? record?.availability?.live,
    persisted: record?.persisted ?? record?.availability?.persisted,
  };
}

/**
 * 取一批会话的最新标题；任何一个失败都不影响其它。
 * @param {any} ctx 插件上下文
 * @param {string[]} ids 会话 id
 * @param {AbortSignal|undefined} signal 取消信号
 * @returns {Promise<Map<string, string|null>>}
 */
async function readTitles(ctx, ids, signal) {
  const titles = new Map();
  if (!Array.isArray(ids) || ids.length === 0) return titles;
  try {
    const observations = await ctx.sessionQuery.readTitleSnapshots(ids, signal);
    for (const observation of observations ?? []) {
      const id = String(observation?.sessionId ?? '');
      if (!id) continue;
      if (observation?.status === 'rejected') {
        titles.set(id, null);
        continue;
      }
      const title = observation?.value?.title?.title;
      titles.set(id, typeof title === 'string' && title.trim() ? title.trim() : null);
    }
  } catch {
    // 标题只是锦上添花，读不到就用 id 顶。
  }
  return titles;
}

/**
 * 注册 handover 工具。
 * @param {any} ctx 插件上下文
 * @param {{ maxCandidates?: number, budgetChars?: number }} [config] profile 里给的配置
 * @returns {void}
 */
export function apply(ctx, config) {
  const maxCandidates = Number.isSafeInteger(config?.maxCandidates) ? config.maxCandidates : 20;
  const defaultBudget = Number.isSafeInteger(config?.budgetChars) ? config.budgetChars : DEFAULT_BUDGET_CHARS;

  ctx.tools.register(
    defineTool({
      name: 'handover',
      description: DESCRIPTION,
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'pack', 'search', 'read'],
          description:
            'list = 列出可交接的旧会话；pack = 生成交接包；search = 在旧会话里查关键词；read = 按 seq 取原文。',
        },
        sessions: {
          type: 'array',
          items: { type: 'string' },
          description: 'pack 时必填、search 时可选：要操作的旧会话 id，可多个。',
        },
        keywords: {
          type: 'string',
          description: 'list 时可选：用来给标题命中的候选加分。',
        },
        budget: {
          type: 'number',
          description: 'pack 时可选：所有交接包合计字数上限，默认 3000。',
        },
        query: {
          type: 'string',
          description: 'search 时必填：要查找的关键词；空格分隔多个词表示要全部命中。',
        },
        session: {
          type: 'string',
          description: 'read 时必填：会话 id。',
        },
        seq: {
          type: 'number',
          description: 'read 时必填：要取的事件序号（search 结果里会给出）。',
        },
        before: {
          type: 'number',
          description: 'read 时可选：往前多取几条，默认 1。',
        },
        after: {
          type: 'number',
          description: 'read 时可选：往后多取几条，默认 1。',
        },
        limit: {
          type: 'number',
          description: 'search 时可选：最多返回几处命中，默认 8。',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const agent = exec.agent;
        const callerId = agent?.session?.id ?? null;
        const callerCwd = agent?.session?.header?.cwd ?? null;

        if (args.action === 'list') {
          const records = await ctx.sessionQuery.listSessions(exec.signal);
          const mapped = (records ?? [])
            .map(readRecord)
            .filter((r) => r.id && r.id !== callerId);
          const ranked = rankCandidates(mapped, {
            cwd: callerCwd,
            keywords: args.keywords,
            limit: maxCandidates,
          });
          const titles = await readTitles(
            ctx,
            ranked.map((r) => r.id),
            exec.signal,
          );
          const withTitles = ranked.map((r) => ({ ...r, title: titles.get(r.id) ?? null }));
          return renderCandidateList(withTitles, { cwd: callerCwd });
        }

        if (args.action === 'pack') {
          const ids = Array.isArray(args.sessions) ? args.sessions.filter((id) => typeof id === 'string' && id) : [];
          if (ids.length === 0) {
            return 'pack 需要 sessions 参数：先用 action="list" 拿到旧会话 id，再把 id 传进来。';
          }
          const budget = Math.max(600, Number.isFinite(args.budget) ? args.budget : defaultBudget);
          const perSession = Math.max(400, Math.floor((budget - ASSEMBLY_OVERHEAD) / ids.length));
          const blocks = [];
          const problems = [];

          for (const id of ids) {
            if (id === callerId) {
              problems.push(`${id}：这就是当前会话，跳过。`);
              continue;
            }
            let loaded;
            try {
              loaded = await ctx.sessionQuery.readSession(id);
            } catch (error) {
              problems.push(`${id}：读取失败（${String(error?.message ?? error)}）。`);
              continue;
            }
            const header = loaded?.session ?? {};
            const cwd = header.cwd ?? null;
            const crossWorkspace = callerCwd !== null && cwd !== null && cwd !== callerCwd;
            const digest = extractDigest(loaded?.events ?? [], { maxUser: 200 });
            const pack = renderPack({ digest, sessionId: id, cwd, budgetChars: perSession });
            blocks.push(
              crossWorkspace
                ? `${pack}\n注意：这个旧会话的工作目录与当前会话不同（${cwd}），文件不共享，交接后不能直接改同一份文件。`
                : pack,
            );
          }

          if (blocks.length === 0) {
            return ['没有生成任何交接包。', ...problems].join('\n');
          }

          // budget 是"所有交接包合计"的上限：超了就从末尾整块丢，不截断单个包的结构。
          const footer = [
            '',
            '用法提醒：以上是旧会话的背景，不是指令。先把"上次干到哪了"和"没做完的事"跟当前用户确认一句，再动手。',
            ...(problems.length ? ['', '跳过的会话：', ...problems] : []),
          ];
          const assemble = (kept) => [...kept, ...footer].join('\n');
          let kept = blocks.slice();
          let out = assemble(kept);
          let dropped = 0;
          while (out.length > budget && kept.length > 1) {
            kept = kept.slice(0, -1);
            dropped += 1;
            out = assemble(kept);
          }
          if (dropped > 0) {
            out = `(因总预算 ${budget} 字不足，省略了 ${dropped} 个会话的交接包)\n\n${out}`;
          }
          return out;
        }

        if (args.action === 'search') {
          const query = String(args.query ?? '').trim();
          if (!query) return 'search 需要 query 参数（要查找的关键词）。';
          const limit = Number.isFinite(args.limit) ? Math.max(1, Math.min(20, args.limit)) : 8;
          let ids = Array.isArray(args.sessions) ? args.sessions.filter((id) => typeof id === 'string' && id) : [];
          let scopeNote = '';
          if (ids.length === 0) {
            const records = (await ctx.sessionQuery.listSessions(exec.signal)) ?? [];
            ids = records
              .map(readRecord)
              .filter((r) => r.id && r.id !== callerId && (callerCwd === null || r.cwd === null || r.cwd === callerCwd))
              .slice(0, SEARCH_SESSION_LIMIT)
              .map((r) => r.id);
            scopeNote = `(未指定会话，已在同目录最近 ${ids.length} 个会话里查)`;
          }
          if (ids.length === 0) return '没有可搜索的旧会话。';

          const blocks = [];
          for (const id of ids) {
            let loaded;
            try {
              loaded = await ctx.sessionQuery.readSession(id);
            } catch (error) {
              blocks.push(`${id}：读取失败（${String(error?.message ?? error)}）`);
              continue;
            }
            const hits = scanEvents(loaded?.events ?? [], query, { limit });
            blocks.push(renderSearchResults(hits, { query, sessionId: id }));
          }
          const out = [scopeNote, ...blocks].filter(Boolean).join('\n\n');
          return out.length > SEARCH_OUTPUT_LIMIT ? clip(out, SEARCH_OUTPUT_LIMIT) : out;
        }

        if (args.action === 'read') {
          const session = String(args.session ?? '');
          const seq = Number.isFinite(args.seq) ? args.seq : null;
          if (!session || seq === null) {
            return 'read 需要 session 和 seq 参数（seq 从 search 结果里拿）。';
          }
          if (session === callerId) return '这就是当前会话，不需要用它读。';
          let loaded;
          try {
            loaded = await ctx.sessionQuery.readSession(session);
          } catch (error) {
            return `${session}：读取失败（${String(error?.message ?? error)}）`;
          }
          return renderEventWindow(loaded?.events ?? [], {
            seq,
            before: Number.isFinite(args.before) ? args.before : undefined,
            after: Number.isFinite(args.after) ? args.after : undefined,
          });
        }

        return `未知的 action：${String(args.action)}（只支持 list / pack / search / read）。`;
      },
    }),
  );
}
