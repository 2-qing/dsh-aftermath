/**
 * dsh-aftermath —— 从「后果」倒查「AI 干了什么」。
 *
 * 观测点只有一处：session/event。不用 fs.watch（NTFS 会丢事件），
 * 不用 tools/pre-execute / post-execute（那是改造结果用的，且拿不到全貌）。
 * 每一轮自带前后两份快照做差，"后果"是文件系统的事实，"原因"才是归因的猜测。
 *
 * 稳定性约定：
 * - 每个回调 full try/catch，任何异常只记日志，绝不外抛；
 * - 不使用子进程、不读注册表、不读文件内容、不自动还原；
 * - 不注册系统提示词 section（不碰前缀缓存）。
 */
import { DEFAULTS, normalizeConfig, resolveRoots, stateDir } from './config.js';
import { Config, readField, SCHEMA_SOURCE } from './schema.js';
import { scanRoots } from './scan.js';
import { diffSnapshotPair, toChangeList } from './diff.js';
import { attributeChanges, summarizeConfidence, extractEvidence, analyzeIntervals } from './attribution.js';
import { appendTurn, ensureDirs, loadBaseline, pruneTurns, saveBaseline, saveResolvedConfig, saveSettingsProbe } from './store.js';
import { renderChatLine } from './report.js';
import { installCommands, buildHistoryText } from './commands.js';
import { VERSION } from './version.js';

export const name = 'dsh-aftermath';

// 本插件要注册 aftermath_history 工具，因此依赖 `tools` 服务。
// 之前误留空：Cordis 里访问 ctx.tools 必须先在这里声明，否则 activate
// 阶段会抛 "cannot get property 'tools' without inject"（工具注册那行的
// `if (ctx.tools)` 护不住，因为读属性本身就会抛）。
export const inject = ['tools'];

// 行 Config：宿主据此在 Plugins 页提供设置卡片；字段全部 volatile，
// 改完立即生效（不重启插件，因此不丢当前基线）。拿不到 schemastery 时为
// undefined——宿主会原样透传配置，插件功能不受影响，只是没有图形界面。
export { Config };

function sessionKey(session) {
  if (!session) return 'unknown';
  if (typeof session.id === 'string') return session.id;
  if (typeof session.sessionId === 'string') return session.sessionId;
  return 'anonymous';
}

function toEvent(first, second) {
  if (second && typeof second.type === 'string') return second;
  if (first && typeof first.type === 'string') return first;
  return null;
}

function snapshot(roots, cfg) {
  try {
    return scanRoots(roots, cfg);
  } catch {
    return roots.map((root) => ({
      id: root.id,
      root: root.path,
      ok: false,
      error: 'scan-crashed',
      entries: [],
      count: 0,
    }));
  }
}

function sameSnapshot(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].id !== b[i].id) return false;
    const left = a[i].entries || [];
    const right = b[i].entries || [];
    if (left.length !== right.length) return false;
    for (let j = 0; j < left.length; j += 1) {
      if (left[j].rel !== right[j].rel) return false;
      if (left[j].size !== right[j].size) return false;
      if (left[j].mtime !== right[j].mtime) return false;
    }
  }
  return true;
}

export function apply(ctx, rawConfig) {
  const raw = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};

  /**
   * 每次取用前重新读一遍配置。
   * volatile 字段在宿主里是 Volatile 引用（`config.field.get()`），所以这里读到的
   * 永远是「用户此刻在设置卡片里选中的值」，不需要重启插件。
   */
  const readLiveConfig = () => {
    const picked = {};
    for (const key of Object.keys(DEFAULTS)) {
      const value = readField(raw, key);
      if (value !== undefined) picked[key] = value;
    }
    return normalizeConfig(picked);
  };

  let cfg = readLiveConfig();
  let roots = resolveRoots(cfg);
  const state = { lastAt: 0, lastError: null, turns: 0, appended: 0 };
  const deps = { ctx, cfg, roots, state };

  /** 宿主不同版本对 ctx.logger 的形态不一致，取不到就静默丢弃。 */
  const logger = (level, message) => {
    try {
      const log = typeof ctx.logger === 'function' ? ctx.logger('aftermath') : null;
      if (log && typeof log[level] === 'function') log[level](message);
    } catch {
      /* 日志不可用就算了 */
    }
  };

  /** 刷新 deps 上的活动配置；任何失败都退回上一次的值，绝不让调用方踩空。 */
  const refresh = () => {
    try {
      const next = readLiveConfig();
      const nextRoots = resolveRoots(next);
      cfg = next;
      roots = nextRoots;
      deps.cfg = next;
      deps.roots = nextRoots;
    } catch (error) {
      state.lastError = `读取配置失败：${error?.message || error}`;
    }
    return cfg;
  };
  deps.refresh = refresh;

  /**
   * 设置命名空间自检。
   * 宿主只为「导出 schemastery Config 且已激活」的条目提供设置命名空间；拿不到时
   * Plugins 页的卡片只剩一段说明，用户没法改配置，而且没有任何提示说明为什么。
   * 这里把宿主真正看到的命名空间记下来（只有命名空间名和字段名，没有值），
   * 启动时落一份到状态目录，同时供 `/aftermath doctor` 现场查询。
   */
  deps.settings = null;
  deps.lastProbe = null;
  /**
   * describe() 回来的命名空间视图里，schema 是 toJSON 之后的 {uid, refs} 快照，
   * 没有 dict；字段名只能从值对象（value/user/base）上取，取不到再看 refs。
   */
  const fieldsOf = (row) => {
    for (const bucket of [row?.value, row?.user, row?.base]) {
      if (bucket && typeof bucket === 'object') {
        const keys = Object.keys(bucket);
        if (keys.length > 0) return keys;
      }
    }
    const refs = row?.schema?.refs;
    const uid = row?.schema?.uid;
    const node = refs && uid !== undefined ? refs[uid] : null;
    const props = node?.properties;
    return props && typeof props === 'object' ? Object.keys(props) : [];
  };
  deps.probeSettings = () => {
    const report = {
      at: new Date().toISOString(),
      plugin: name,
      version: VERSION,
      configExported: typeof Config === 'function',
      schemaSource: SCHEMA_SOURCE,
      namespaces: null,
      ourNamespace: false,
      error: null,
    };
    const settings = deps.settings;
    if (!settings || typeof settings.describe !== 'function') {
      report.error = 'settings 服务不可用：宿主没有提供给这个插件';
      deps.lastProbe = report;
      return report;
    }
    try {
      report.namespaces = settings.describe({ redactSecrets: true }).map((row) => ({
        ns: row?.ns ?? null,
        fields: fieldsOf(row),
      }));
      report.ourNamespace = report.namespaces.some((row) => row.ns === name);
      if (!report.ourNamespace) {
        report.error = `宿主没有为 ${name} 建立设置命名空间：Config ${report.configExported ? '已导出' : '未导出'}`;
      }
    } catch (error) {
      report.error = `describe 失败：${error?.message || error}`;
    }
    deps.lastProbe = report;
    return report;
  };
  /**
   * 启动那一瞬间本插件的 fiber 很可能还没进入 ACTIVE，describe() 自然看不到自己。
   * 所以隔一会儿再探一次，写满最后一次结果；仍然失败就保留，让 /aftermath doctor 说话。
   */
  const reprobe = () => {
    if (deps.lastProbe?.ourNamespace) return;
    try {
      const report = deps.probeSettings();
      if (report?.namespaces) saveSettingsProbe(report);
    } catch (error) {
      logger('warn', `设置自检重探失败：${error?.message || error}`);
    }
  };

  try {
    ctx.inject(['settings'], (settingsCtx) => {
      try {
        deps.settings = settingsCtx.get('settings');
        saveSettingsProbe(deps.probeSettings());
        if (!deps.settings) return;
        logger('info', '设置命名空间已就绪');
        const timer = setTimeout(reprobe, 3000);
        if (timer && typeof timer.unref === 'function') timer.unref();
      } catch (error) {
        logger('warn', `设置自检失败：${error?.message || error}`);
      }
    });
  } catch (error) {
    logger('warn', `settings 服务注入失败：${error?.message || error}`);
  }
  const sessions = new WeakMap();

  try {
    const dirs = ensureDirs();
    if (!dirs.ok) state.lastError = `状态目录不可写：${dirs.error}`;
    saveResolvedConfig({
      version: VERSION,
      enabled: cfg.enabled,
      depth: cfg.depth,
      maxEntries: cfg.maxEntries,
      retentionDays: cfg.retentionDays,
      roots: roots.map((root) => ({ id: root.id, path: root.path })),
      stateDir: stateDir(),
    });
    const pruned = pruneTurns(cfg.retentionDays);
    if (pruned > 0) logger('info', `清理了 ${pruned} 个过期存档`);
  } catch (error) {
    state.lastError = error?.message || String(error);
  }

  if (!cfg.enabled) {
    // 不 return：开关要能在运行中打开。每轮开始/结束各自判一次 enabled。
    logger('info', 'enabled=false，本轮不做快照（可在设置里随时打开）');
  }

  if (roots.length === 0) {
    logger('warn', '没有解析出任何观测根；检查配置里的 roots / extraRoots');
  }

  const finalizeTurn = (session, turnNumber) => {
    const entry = sessions.get(session);
    if (!entry || !entry.pre) return;
    refresh();
    if (!cfg.enabled) {
      sessions.set(session, { pre: null, at: entry.at, calls: [], turn: entry.turn });
      return;
    }
    const at = Date.now();
    const post = snapshot(roots, cfg);
    let delta = { created: [], deleted: [], modified: [], roots: [], skipped: [] };
    try {
      delta = diffSnapshotPair(entry.pre, post);
    } catch (error) {
      state.lastError = `diff 失败：${error?.message || error}`;
      logger('warn', state.lastError);
      return;
    }

    const all = toChangeList(delta);
    const limited = all.slice(0, cfg.maxChangesPerReport);
    const attributed = attributeChanges(limited, entry.calls || [], {
      slackMs: cfg.intervalSlackMs,
      turnEndAt: at,
    });
    const confidence = summarizeConfidence(attributed);
    const intervals = analyzeIntervals(entry.calls || [], {
      slackMs: cfg.intervalSlackMs,
      turnEndAt: at,
    });
    const scanMs = post.reduce((sum, snap) => sum + (Number.isFinite(snap.ms) ? snap.ms : 0), 0);
    const scanned = post.reduce((sum, snap) => sum + (snap.count || 0), 0);
    const changed = all.filter((c) => c.kind === 'created' || c.kind === 'deleted' || c.kind === 'modified').length;
    const health = {
      scanMs: Math.round(scanMs),
      roots: post.length,
      scanned,
      changed,
      listed: limited.length,
      truncated: all.length > limited.length,
      intervals,
    };
    const counts = {
      created: all.filter((c) => c.kind === 'created').length,
      deleted: all.filter((c) => c.kind === 'deleted').length,
      modified: all.filter((c) => c.kind === 'modified').length,
      moved: all.filter((c) => c.kind === 'moved').length,
      total: all.length,
      confidence,
    };

    const record = {
      v: 1,
      at,
      session: sessionKey(session),
      turn: Number.isInteger(turnNumber) ? turnNumber : entry.turn ?? 0,
      startedAt: entry.at,
      durationMs: Math.max(0, at - (entry.at || at)),
      version: VERSION,
      roots: delta.roots,
      skipped: delta.skipped,
      counts,
      health,
      changes: attributed.map((change) => ({
        kind: change.kind,
        rootId: change.rootId,
        root: change.root,
        rel: change.rel,
        abs: change.root && change.rel ? `${change.root}\\${change.rel}` : change.rel,
        before: change.before ? { size: change.before.size, mtime: change.before.mtime, dir: change.before.dir } : null,
        after: change.after ? { size: change.after.size, mtime: change.after.mtime, dir: change.after.dir } : null,
        heuristic: change.heuristic === true,
        movedFrom: change.movedFrom || null,
        attribution: change.attribution || null,
      })),
      calls: (entry.calls || []).slice(0, 20).map((call) => {
        let evidence = null;
        try {
          evidence = extractEvidence(call);
        } catch {
          evidence = null;
        }
        return {
          name: call.name || evidence?.name || 'tool',
          verb: evidence?.verb || null,
          mutating: evidence?.mutating === true,
          excerpt: evidence?.excerpt || '',
          at: call.at || null,
          endAt: typeof call.endAt === 'number' ? call.endAt : null,
        };
      }),
      truncated: all.length > limited.length,
    };

    try {
      saveBaseline({ at, roots: post });
    } catch {
      /* 基线失败不影响主流程 */
    }

    if (all.length > 0) {
      const file = appendTurn(record);
      if (file) state.appended += 1;
      else state.lastError = '写入记录失败（状态目录不可写？）';
      state.lastAt = at;
    }
    state.turns += 1;
    sessions.set(session, { pre: post, at, calls: [], turn: entry.turn });
  };

  const onEvent = (first, second) => {
    const event = toEvent(first, second);
    if (!event) return;
    const session = second && typeof second.type === 'string' ? first : first?.session ?? first;
    const type = event.type;
    try {
      if (type === 'turn/start') {
        const at = Date.now();
        refresh();
        const pre = cfg.enabled ? snapshot(roots, cfg) : null;
        sessions.set(session, { pre, at, calls: [], turn: event.data?.turn ?? 0 });
        return;
      }
      if (type === 'tool/call') {
        const entry = sessions.get(session);
        if (!entry) return;
        const at = Number.isFinite(event.time) ? event.time : Date.now();
        entry.calls.push({
          callId: event.data?.callId ?? null,
          name: event.data?.name ?? 'tool',
          arguments: typeof event.data?.arguments === 'string' ? event.data.arguments : '',
          at,
          step: Number.isInteger(event.data?.step) ? event.data.step : null,
          /** 调用结束时刻；等 tool/result 回来时补上。 */
          endAt: null,
        });
        if (entry.calls.length > 200) entry.calls.splice(0, entry.calls.length - 200);
        return;
      }
      if (type === 'tool/result') {
        // 只用来给对应的 tool/call 打上结束时刻，判定「这次调用持续到几点」。
        // 先按同一 step 配对（并行调用时同 step 才是同一批），配不上再取最早未结束的那条。
        const entry = sessions.get(session);
        if (!entry || entry.calls.length === 0) return;
        const at = Number.isFinite(event.time) ? event.time : Date.now();
        const step = Number.isInteger(event.data?.step) ? event.data.step : null;
        const pending = entry.calls.filter((call) => call.endAt === null);
        if (pending.length === 0) return;
        const byStep = step === null ? null : pending.find((call) => call.step === step);
        const target = byStep || pending[0];
        target.endAt = Math.max(at, target.at ?? at);
        return;
      }
      if (type === 'turn/end') {
        finalizeTurn(session, event.data?.turn);
      }
    } catch (error) {
      state.lastError = `${type}: ${error?.message || error}`;
      logger('warn', `事件处理失败 ${type}：${state.lastError}`);
    }
  };

  try {
    ctx.on('session/event', onEvent);
  } catch (error) {
    state.lastError = `订阅 session/event 失败：${error?.message || error}`;
    logger('error', state.lastError);
  }

  try {
    installCommands(ctx, deps);
  } catch (error) {
    logger('warn', `命令注册失败：${error?.message || error}`);
  }

  if (ctx.tools && typeof ctx.tools.register === 'function') {
    try {
      ctx.tools.register({
        name: 'aftermath_history',
        description:
          '读取 dsh-aftermath 在本机记录的文件变更历史：哪一轮删/改/移了哪些文件、能归因到哪条工具调用。' +
          '当用户说「桌面的东西不见了」「图标全变白了」「某个目录被谁动了」时，用它按时间倒查。只读，不修改任何文件。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            since: { type: 'string', description: '时间范围，如 30m、2h、1d，缺省为最近若干轮' },
            root: {
              type: 'string',
              enum: ['all', 'desktop', 'downloads', 'documents'],
              description: '限定观测根，默认 all',
            },
            limit: { type: 'integer', description: '最多看几轮，默认 3，上限 20' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { text: { type: 'string' } },
          },
          render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
        },
        async execute(args) {
          try {
            return { text: buildHistoryText(deps, args || {}) };
          } catch (error) {
            return { text: `读取 aftermath 记录失败：${error?.message || error}` };
          }
        },
      });
    } catch (error) {
      logger('warn', `工具注册失败：${error?.message || error}`);
    }
  }

  logger('info', `已启用，观测根 ${roots.map((root) => root.id).join(', ') || '（无）'}，depth=${cfg.depth}`);
}

export { renderChatLine, loadBaseline, sameSnapshot };
