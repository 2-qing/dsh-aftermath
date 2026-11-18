/**
 * /aftermath 命令。只读历史 + 主动扫描，不改任何文件、不执行任何命令。
 *
 * 所有处理都包在 try/catch 里：命令报错只该返回一句 error，不该把宿主搞挂。
 */
import { registerCommand } from './command-registration.js';
import { scanRoots } from './scan.js';
import { diffSnapshotPair, toChangeList } from './diff.js';
import { attributeChanges, summarizeConfidence } from './attribution.js';
import { detectSymptoms } from './symptoms.js';
import { renderHistory, renderTurnReport } from './report.js';
import { loadBaseline, readTurns, saveBaseline, writeReport, dayKey } from './store.js';
import { stateDir } from './config.js';
import { SCHEMA_SOURCE } from './schema.js';
import { VERSION } from './version.js';

const MAX_TEXT = 14000;

const HELP = [
  '/aftermath report [--last N | --since 2h] [--root desktop] [--save]  看变更明细与归因',
  '/aftermath scan [--keep]                                             立刻扫描，对比上次观测到的基线',
  '/aftermath roots                                                   打印解析出的观测根',
  '/aftermath status                                                  配置与存档状态',
  '/aftermath doctor                                                  自检：设置命名空间是否就绪',
  '/aftermath help                                                    这张表',
].join('\n');

function parseDuration(token) {
  const match = /^(\d+)\s*(s|m|h|d)?$/i.exec(String(token || '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  const factor = unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
  return n * factor;
}

export function parseArgs(rawInput) {
  const tokens = String(rawInput || '').trim().split(/\s+/).filter(Boolean);
  const sub = (tokens.shift() || 'report').toLowerCase();
  const options = { last: null, sinceMs: null, root: null, save: false, keep: false, unknown: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--save') options.save = true;
    else if (token === '--keep') options.keep = true;
    else if (token === '--last') options.last = Number(tokens[(i += 1)]);
    else if (token === '--root') options.root = String(tokens[(i += 1)] || '').toLowerCase();
    else if (token === '--since') {
      const value = tokens[(i += 1)] || '';
      const ms = parseDuration(value);
      options.sinceMs = ms !== null ? Date.now() - ms : Date.parse(value);
      if (!Number.isFinite(options.sinceMs)) options.sinceMs = null;
    } else options.unknown.push(token);
  }
  return { sub, options };
}

function clampText(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n\n…（输出过长已截断，完整内容用 --save 落盘，或看 ${stateDir()}）`;
}

function filterByRoot(record, rootId) {
  if (!rootId) return record;
  const changes = (record.changes || []).filter((change) => change.rootId === rootId);
  const confidence = summarizeConfidence(changes);
  return {
    ...record,
    changes,
    counts: { ...record.counts, total: changes.length, confidence },
    skipped: (record.skipped || []).filter((item) => item.id === rootId),
    roots: (record.roots || []).filter((root) => root.id === rootId),
  };
}

function scanNow(deps, flags = {}) {
  const { cfg, roots } = deps;
  const now = Date.now();
  const snaps = scanRoots(roots, cfg);
  const baseline = loadBaseline();

  if (!baseline || !Array.isArray(baseline.roots)) {
    saveBaseline({ at: now, roots: snaps });
    const total = snaps.reduce((sum, snap) => sum + (snap.count || 0), 0);
    return {
      text: `第一次扫描，已建立基线：${snaps.length} 个根、${total} 个条目。\n以后再来 /aftermath scan 就能看到这段时间内发生了什么。`,
      record: null,
    };
  }

  const delta = diffSnapshotPair(baseline.roots, snaps);
  const changes = attributeChanges(toChangeList(delta), []);
  const confidence = summarizeConfidence(changes);
  const record = {
    v: 1,
    at: now,
    session: 'manual-scan',
    turn: 0,
    sinceAt: baseline.at || null,
    roots: delta.roots,
    skipped: delta.skipped,
    counts: {
      created: changes.filter((c) => c.kind === 'created').length,
      deleted: changes.filter((c) => c.kind === 'deleted').length,
      modified: changes.filter((c) => c.kind === 'modified').length,
      moved: changes.filter((c) => c.kind === 'moved').length,
      total: changes.length,
      confidence,
    },
    changes,
    calls: [],
  };

  if (!flags.keep) saveBaseline({ at: now, roots: snaps });
  const header = `扫描区间：${baseline.at ? new Date(baseline.at).toLocaleString() : '上次基线'} → 现在`;
  return { text: clampText(`${header}\n\n${renderTurnReport(record, { maskHome: cfg.maskHome })}`), record };
}

/** 取用配置前先刷新一次：设置卡片里的改动不重启插件也立刻生效。 */
function syncDeps(deps) {
  try {
    if (deps && typeof deps.refresh === 'function') deps.refresh();
  } catch {
    /* 刷新失败就用上一次的值，绝不中断命令 */
  }
  return deps;
}

function rootsText(deps) {
  const { cfg, roots } = deps;
  const lines = [`观测根（depth=${cfg.depth}，上限 ${cfg.maxEntries} 条目）：`, ''];
  for (const root of roots) {
    const snap = { count: 0, ok: true, error: null };
    try {
      const scanned = scanRoots([root], { ...cfg, depth: 0 });
      snap.count = scanned[0]?.count || 0;
      snap.ok = scanned[0]?.ok !== false;
      snap.error = scanned[0]?.error || null;
    } catch {
      snap.ok = false;
    }
    lines.push(`- ${root.id}: ${root.path}  ${snap.ok ? `顶层 ${snap.count} 条` : `读不到（${snap.error}）`}`);
  }
  lines.push('');
  lines.push(`状态目录：${stateDir()}`);
  lines.push('如果路径不对：打开 Plugins 页的「文件变更记录」卡片改观测目录，保存后立即生效。');
  return lines.join('\n');
}

export function doctorText(deps) {
  const report = typeof deps.probeSettings === 'function' ? deps.probeSettings() : null;
  if (!report) {
    return [`dsh-aftermath  v${VERSION}`, '拿不到自检结果：宿主设置服务不可用，或插件版本过旧。'].join('\n');
  }
  const lines = [
    `dsh-aftermath  v${VERSION}  ·  ${report.at}`,
    `Config 导出：${report.configExported ? '是' : '否'}`,
    `schema 来源：${report.schemaSource || '未加载到 @deepseek-ai/schemastery'}`,
    `设置命名空间：${report.ourNamespace ? '已就绪，卡片可编辑全部字段' : '缺失，卡片只能改总开关'}`,
  ];
  if (report.namespaces) {
    const list = report.namespaces.map((row) => row.ns).join(', ');
    lines.push(`宿主可见命名空间（${report.namespaces.length}）：${list || '无'}`);
    const ours = report.namespaces.find((row) => row.ns === report.plugin);
    if (ours) lines.push(`本插件可见字段（${ours.fields?.length ?? 0}）：${ours.fields?.join(', ') || '无'}`);
  }
  if (report.error) lines.push(`问题：${report.error}`);
  lines.push(`自检快照：${stateDir()}/settings-probe.json`);
  return lines.join('\n');
}

function statusText(deps) {
  const { cfg, roots, state } = deps;
  const today = readTurns({ sinceMs: Date.parse(`${dayKey()}T00:00:00`), limit: 500 });
  const lines = [
    `dsh-aftermath  v${VERSION}  ${cfg.enabled ? '已启用' : '已停用（enabled=false）'}`,
    `观测根：${roots.map((r) => r.id).join(', ') || '无'}`,
    `快照：depth=${cfg.depth}，上限 ${cfg.maxEntries}，排除 ${cfg.exclude.length} 条规则`,
    `归因：调用区间容差 ${cfg.intervalSlackMs} ms`,
    `保留：${cfg.retentionDays} 天`,
    `状态目录：${stateDir()}`,
    `设置表单：${SCHEMA_SOURCE ? `已就绪（schema 取自 ${SCHEMA_SOURCE}）` : '不可用：没解析到 @deepseek-ai/schemastery，卡片只能改总开关，其余靠配置文件的 yml'}`,
    `今天已记录：${today.length} 轮${state.lastAt ? `，最近一轮 ${new Date(state.lastAt).toLocaleString()}` : ''}`,
  ];
  const changed = today.reduce((sum, record) => sum + (record?.counts?.total || 0), 0);
  lines.push(`今天变更总数：${changed}`);
  if (state.lastError) lines.push(`最近一次错误：${state.lastError}`);
  return lines.join('\n');
}

async function reportText(deps, options) {
  let records = [];
  if (options.sinceMs) records = readTurns({ sinceMs: options.sinceMs, limit: 50 });
  else records = readTurns({ limit: Number.isInteger(options.last) && options.last > 0 ? options.last : 1 });

  if (records.length === 0) {
    return '这段时间没有记录到文件变更。\n可能原因：观测根里确实没动过东西，或插件刚装还没跑过完整的一轮。';
  }

  const filtered = records.map((record) => filterByRoot(record, options.root));

  let text;
  if (filtered.length === 1) {
    text = renderTurnReport(filtered[0], { maskHome: deps.cfg.maskHome });
  } else {
    text = renderHistory(filtered);
    const last = filtered[0];
    if (last && (last.counts?.total || 0) > 0) {
      text += `\n\n---\n\n## 最近一轮明细\n\n${renderTurnReport(last, { maskHome: deps.cfg.maskHome })}`;
    }
  }

  if (options.save) {
    const name = `${dayKey()}-${Date.now().toString(36)}`;
    const file = writeReport(name, text);
    if (file) text += `\n\n已保存：${file}`;
  }
  return clampText(text);
}

export function installCommands(ctx, deps) {
  ctx.inject(['commands'], (host) => {
    const commands = host.get('commands');
    if (!commands || typeof commands.register !== 'function') return;
    registerCommand(
      commands,
      {
        name: 'aftermath',
        description: '查「AI 这一轮到底动了哪些文件」：逐条变更 + 归因到具体命令 + 症状对照。只读。',
        input: { hint: 'report [--last N|--since 2h] | scan | roots | status | help' },
        handler: async (invocation) => {
          try {
            syncDeps(deps);
            const { sub, options } = parseArgs(invocation?.rawInput);
            if (sub === 'help' || sub === '-h' || sub === '?') return { kind: 'success', text: HELP };
            if (sub === 'roots') return { kind: 'success', text: rootsText(deps) };
            if (sub === 'status') return { kind: 'success', text: statusText(deps) };
            if (sub === 'doctor') return { kind: 'success', text: doctorText(deps) };
            if (sub === 'scan') {
              const result = scanNow(deps, { keep: options.keep === true });
              return { kind: 'success', text: result.text };
            }
            if (sub === 'report') return { kind: 'success', text: await reportText(deps, options) };
            return { kind: 'error', text: `不认识子命令 ${sub}\n\n${HELP}` };
          } catch (error) {
            return { kind: 'error', text: `aftermath 执行失败：${error?.message || error}` };
          }
        },
      },
      'aftermath-view',
      (message) => {
        try {
          ctx.logger?.('aftermath')?.warn?.(message);
        } catch {
          /* 记日志失败无所谓 */
        }
      },
    );
  });
}

/** 供 aftermatch_history 工具复用：把历史渲染成一段文本。 */
export function buildHistoryText(deps, args) {
  syncDeps(deps);
  const options = { last: null, sinceMs: null, root: null, save: false };
  const since = typeof args?.since === 'string' ? parseDuration(args.since) : null;
  if (since !== null) options.sinceMs = Date.now() - since;
  if (typeof args?.root === 'string' && args.root !== 'all') options.root = args.root.toLowerCase();
  const limit = Number.isInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 20) : 3;
  options.last = limit;
  const records = readTurns({ sinceMs: options.sinceMs || 0, limit });
  if (records.length === 0) return '没有可用的 aftermath 记录。';
  const filtered = records.map((record) => filterByRoot(record, options.root));
  const withChanges = filtered.filter((record) => (record.counts?.total || 0) > 0);
  if (withChanges.length === 0) {
    return `最近 ${records.length} 轮没有观测到文件变更（观测根：${deps.roots.map((r) => r.id).join(', ')}）。`;
  }
  const parts = [renderHistory(withChanges)];
  parts.push('---');
  parts.push(renderTurnReport(withChanges[0], { maskHome: deps.cfg.maskHome }));
  const symptoms = detectSymptoms(withChanges[0].changes || [], { roots: withChanges[0].roots || [] });
  if (symptoms.length === 0) parts.push('\n（这份记录里没有匹配到已知症状）');
  return clampText(parts.join('\n\n'));
}
