/**
 * /aftermath 命令。只读历史 + 主动扫描，不改任何文件、不执行任何命令。
 *
 * 所有处理都包在 try/catch 里：命令报错只该返回一句 error，不该把宿主搞挂。
 */
import fs from 'node:fs';
import path from 'node:path';
import { registerCommand } from './command-registration.js';
import { scanRoots } from './scan.js';
import { diffSnapshotPair, toChangeList } from './diff.js';
import { attributeChanges, summarizeConfidence } from './attribution.js';
import { detectSymptoms } from './symptoms.js';
import { renderHistory, renderTurnReport } from './report.js';
import { loadBaseline, readTurns, saveBaseline, writeReport, dayKey, diskUsage, readPins, writePins } from './store.js';
import { resolveRoots, stateDir } from './config.js';
import { SCHEMA_SOURCE } from './schema.js';
import { VERSION } from './version.js';

const MAX_TEXT = 14000;

const HELP = [
  '/aftermath report [--last N | --since 2h] [--root desktop] [--save]  看变更明细与归因',
  '/aftermath scan [--keep]                                             立刻扫描，对比上次观测到的基线',
  '/aftermath roots                                                   打印解析出的观测根\n/aftermath roots --suggest | --add <路径> | --remove <路径>        推荐目录 / 预览加或减之后的样子',
  '/aftermath status                                                  配置与存档状态',
  '/aftermath doctor                                                  自检：设置命名空间是否就绪',
  '/aftermath pin [2026-11-18 | last]                                 钉住某天的记录，超过保留天数也不清理',
  '/aftermath unpin [2026-11-18 | last | --all]                       解除钉住',
  '/aftermath pins                                                    看现在钉住了哪些天',
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
  const options = { last: null, sinceMs: null, root: null, save: false, keep: false, suggest: false, add: null, remove: null, arg: null, all: false, unknown: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '--save') options.save = true;
    else if (token === '--keep') options.keep = true;
    else if (token === '--suggest') options.suggest = true;
    else if (token === '--add') options.add = String(tokens[(i += 1)] || '');
    else if (token === '--remove') options.remove = String(tokens[(i += 1)] || '');
    else if (token === '--last') options.last = Number(tokens[(i += 1)]);
    else if (token === '--root') options.root = String(tokens[(i += 1)] || '').toLowerCase();
    else if (token === '--since') {
      const value = tokens[(i += 1)] || '';
      const ms = parseDuration(value);
      options.sinceMs = ms !== null ? Date.now() - ms : Date.parse(value);
      if (!Number.isFinite(options.sinceMs)) options.sinceMs = null;
    } else if (token === '--all') options.all = true;
    else if (options.arg === null) options.arg = token;
    else options.unknown.push(token);
  }
  return { sub, options };
}

function clampText(text) {
  if (text.length <= MAX_TEXT) return text;
  return `${text.slice(0, MAX_TEXT)}\n\n…（输出过长已截断，完整内容用 --save 落盘，或看 ${stateDir()}）`;
}

function filterByRoot(record, rootId) {
  if (!rootId || rootId === 'all') return record;
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

/** 探测家用常见目录，标出哪些已经在观测范围里。 */
function suggestRoots(deps) {
  const cfg = deps.cfg || {};
  const resolved = Array.isArray(deps.roots) ? deps.roots : [];
  const lowerRoots = resolved.map((root) => String(root.path || '').toLowerCase());
  const candidates = ['desktop', 'documents', 'downloads', 'pictures', 'music', 'videos'];
  const lines = ['推荐的观测目录（按小白最常丢东西的顺序）：', ''];
  for (const id of candidates) {
    const one = resolveRoots({ ...cfg, roots: [id], extraRoots: [] })[0];
    if (!one) continue;
    const covered = lowerRoots.some((root) => root === one.path.toLowerCase());
    lines.push(`- ${covered ? '[已加]' : '[未加]'} ${id}: ${one.path}${one.exists ? '' : '（这个目录不存在）'}`);
  }
  lines.push('');
  lines.push('要加/减少目录：打开 Plugins → dsh-aftermath → 卡片里的「要盯着哪些地方」，保存后立即生效。');
  lines.push('也可以用 yml（profile 的 cordis.patch.yml）：');
  lines.push('');
  lines.push('```yaml');
  lines.push('- id: dsh-aftermath');
  lines.push('  config:');
  lines.push(`    roots: [${resolved.map((root) => `'${root.path.replace(/\\/g, '/')}'`).join(', ') || "'desktop'"}]`);
  lines.push('```');
  return lines.join('\n');
}


/**
 * 改观测根：插件不直接写宿主配置（写入要走 settings 服务，失败时会让用户以为改了），
 * 这里只把「改完会变成什么样」和可以直接粘的 yml 给出来，改由用户确认。
 */
function rootsEdit(deps, options) {
  const cfg = deps.cfg || {};
  const current = Array.isArray(deps.roots) ? deps.roots : [];
  const specs = current.map((root) => root.path);
  const index = (value) => {
    const want = String(value).toLowerCase().replace(/[\/]+$/, '');
    return current.findIndex((root) => {
      const pathText = String(root.path || '').toLowerCase().replace(/[\/]+$/, '');
      const idText = String(root.id || '').toLowerCase();
      return pathText === want || idText === want;
    });
  };

  const lines = [];
  if (options.add) {
    if (index(options.add) >= 0) lines.push(`已经在这个目录里了：${options.add}`);
    else {
      specs.push(options.add);
      lines.push(`准备加入：${options.add}`);
    }
  }
  if (options.remove) {
    const at = index(options.remove);
    if (at < 0) lines.push(`没找到要移除的目录：${options.remove}`);
    else {
      lines.push(`准备移除：${specs[at]}`);
      specs.splice(at, 1);
    }
    if (specs.length === 0) lines.push('注意：至少要留一个观测目录，否则不会记录任何东西。');
  }

  lines.push('');
  lines.push('改完之后的观测目录：');
  for (const spec of specs) {
    const resolved = resolveRoots({ ...cfg, roots: [spec], extraRoots: [] })[0];
    lines.push(`- ${resolved ? resolved.path : spec}${resolved && resolved.exists === false ? '（不存在）' : ''}`);
  }
  lines.push('');
  lines.push('插件不替你写宿主配置，请二选一：');
  lines.push('1. Plugins → dsh-aftermath → 卡片「要盯着哪些地方？」，把上面的行粘贴进去，点保存（立即生效）；');
  lines.push('2. 或写进 profile 的 cordis.patch.yml：');
  lines.push('');
  lines.push('```yaml');
  lines.push('- id: dsh-aftermath');
  lines.push('  config:');
  lines.push('    roots:');
  for (const spec of specs) lines.push(`      - '${String(spec).split('\\').join('/')}'`);
  lines.push('```');
  return lines.join('\n');
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

function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(deps) {
  const { cfg, roots } = deps;
  const state = deps.state || {};
  const stats = {};
  const today = readTurns({ sinceMs: Date.parse(`${dayKey()}T00:00:00`), limit: 500, stats });
  const usage = diskUsage();
  const pins = readPins();
  const warnMB = Number.isFinite(cfg.storageWarnMB) ? cfg.storageWarnMB : 200;
  const lines = [
    `dsh-aftermath  v${VERSION}  ${cfg.enabled ? '已启用' : '已停用（enabled=false）'}`,
    `观测根：${roots.map((r) => r.id).join(', ') || '无'}`,
    `快照：depth=${cfg.depth}，上限 ${cfg.maxEntries}，排除 ${cfg.exclude.length} 条规则`,
    ...(cfg.depth >= 4
      ? [`性能提示：depth=${cfg.depth} 会让每轮快照明显变慢，观测根是大目录时尤其明显；够用就降到 2`]
      : []),
    `归因：调用区间容差 ${cfg.intervalSlackMs} ms`,
    `零变更回合：${cfg.recordQuietTurns === false ? '不记录' : '有写操作就记一条轻记录（只留命令摘要）'}`,
    `保留：${cfg.retentionDays} 天${pins.days.length > 0 ? `（另钉住 ${pins.days.length} 天，不清理）` : ''}`,
    `状态目录：${stateDir()}`,
    `设置表单：${SCHEMA_SOURCE ? `已就绪（schema 取自 ${SCHEMA_SOURCE}）` : '不可用：没解析到 @deepseek-ai/schemastery，卡片只能改总开关，其余靠配置文件的 yml'}`,
    `今天已记录：${today.length} 轮${state.lastAt ? `，最近一轮 ${new Date(state.lastAt).toLocaleString()}` : ''}`,
    `记录完整性：${stats.corruptLines > 0 ? `跳过 ${stats.corruptLines} 行损坏记录（详情在 ${path.join(stateDir(), 'corrupt.log')}）` : '正常'}`,
    `存档体积：${humanBytes(usage.bytes)}，${usage.files} 个文件${usage.oldest ? `，记录从 ${usage.oldest} 到 ${usage.newest}` : ''}`,
  ];
  if (usage.bytes > warnMB * 1024 * 1024) {
    lines.push(`存储提醒：已超过 ${warnMB} MB 阈值。插件不自己删，要清就调小 retentionDays 或手动清状态目录`);
  }
  lines.push(`钉住：${pins.days.length > 0 ? `${pins.days.join(', ')}（这些天不会被保留天数清理）` : '无'}`);
  const changed = today.reduce((sum, record) => sum + (record?.counts?.total || 0), 0);
  lines.push(`今天变更总数：${changed}`);
  if (state.lastError) lines.push(`最近一次错误：${state.lastError}`);
  return lines.join('\n');
}

function dayOfRecord(record) {
  if (!Number.isFinite(record?.at)) return null;
  return dayKey(new Date(record.at));
}

function resolveDayArg(arg) {
  const text = String(arg || '').trim().toLowerCase();
  if (!text || text === 'last') {
    const [latest] = readTurns({ limit: 1 });
    return dayOfRecord(latest);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return null;
}

function turnFileOf(day) {
  return path.join(stateDir(), 'turns', `${day}.ndjson`);
}

function pinText(deps, options) {
  const day = resolveDayArg(options.arg);
  if (!day) return '用法：/aftermath pin 2026-11-18（也可以写 last，表示最近一轮所在的那天）';
  if (!fs.existsSync(turnFileOf(day))) return `${day} 这天没有记录文件，不用钉。`;
  const pins = readPins();
  if (pins.days.includes(day)) return `${day} 已经在钉住的列表里了。`;
  const ok = writePins({ days: [...pins.days, day] });
  if (!ok) return '写入钉住列表失败，看看状态目录是否可写。';
  return `${day} 已钉住：超过保留天数也不会被清理。\n解除用 /aftermath unpin ${day}`;
}

function unpinText(deps, options) {
  const pins = readPins();
  if (pins.days.length === 0) return '现在没有钉住任何日期。';
  if (options.all === true) {
    const ok = writePins({ days: [] });
    return ok ? `已解除全部钉住（${pins.days.join(', ')}）。` : '写入钉住列表失败，看看状态目录是否可写。';
  }
  const day = resolveDayArg(options.arg);
  if (!day) return '用法：/aftermath unpin 2026-11-18，或 /aftermath unpin --all';
  if (!pins.days.includes(day)) return `${day} 没有被钉住。`;
  const ok = writePins({ days: pins.days.filter((item) => item !== day) });
  return ok ? `${day} 已解除钉住，之后按保留天数正常清理。` : '写入钉住列表失败，看看状态目录是否可写。';
}

function pinsText(deps) {
  const pins = readPins();
  if (pins.days.length === 0) {
    return `现在没有钉住任何日期。\n钉住某天：/aftermath pin 2026-11-18（或 pin last）`;
  }
  const lines = ['钉住的日期（这些天不会被保留天数清理）：'];
  for (const day of pins.days) {
    let size = 0;
    let turns = 0;
    try {
      size = fs.statSync(turnFileOf(day)).size;
      turns = fs.readFileSync(turnFileOf(day), 'utf8').split('\n').filter((line) => line.trim()).length;
    } catch {
      /* 文件不在了就只列日期 */
    }
    lines.push(`- ${day}  ${turns} 轮 / ${humanBytes(size)}`);
  }
  lines.push('');
  lines.push(`解除：/aftermath unpin ${pins.days[pins.days.length - 1]}，或 unpin --all`);
  return lines.join('\n');
}

async function reportText(deps, options) {
  let records = [];
  const stats = {};
  if (options.sinceMs) records = readTurns({ sinceMs: options.sinceMs, limit: 50, stats });
  else records = readTurns({ limit: Number.isInteger(options.last) && options.last > 0 ? options.last : 1, stats });

  if (records.length === 0) {
    return '这段时间没有记录到文件变更。\n可能原因：观测根里确实没动过东西，或插件刚装还没跑过完整的一轮。';
  }

  const filtered = records.map((record) => filterByRoot(record, options.root));

  let text;
  if (filtered.length === 1) {
    text = renderTurnReport(filtered[0], { maskHome: deps.cfg.maskHome, corrupt: stats.corruptLines, maxEntries: deps.cfg.maxEntries });
  } else {
    text = renderHistory(filtered);
    const last = filtered[0];
    if (last && (last.counts?.total || 0) > 0) {
      text += `\n\n---\n\n## 最近一轮明细\n\n${renderTurnReport(last, { maskHome: deps.cfg.maskHome, corrupt: stats.corruptLines, maxEntries: deps.cfg.maxEntries })}`;
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
        input: { hint: 'report [--last N|--since 2h] | scan | roots | status | pin | help' },
        handler: async (invocation) => {
          try {
            syncDeps(deps);
            const { sub, options } = parseArgs(invocation?.rawInput);
            if (sub === 'help' || sub === '-h' || sub === '?') return { kind: 'success', text: HELP };
            if (sub === 'roots') {
              const args = options.args || options;
              if (options.suggest === true || args.suggest === true) {
                return { kind: 'success', text: suggestRoots(deps) };
              }
              if (options.add || options.remove) {
                return { kind: 'success', text: rootsEdit(deps, options) };
              }
              return { kind: 'success', text: rootsText(deps) };
            }
            if (sub === 'status') return { kind: 'success', text: statusText(deps) };
            if (sub === 'pin') return { kind: 'success', text: pinText(deps, options) };
            if (sub === 'unpin') return { kind: 'success', text: unpinText(deps, options) };
            if (sub === 'pins') return { kind: 'success', text: pinsText(deps) };
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
  const stats = {};
  const records = readTurns({ sinceMs: options.sinceMs || 0, limit, stats });
  if (records.length === 0) return '没有可用的 aftermath 记录。';
  const filtered = records.map((record) => filterByRoot(record, options.root));
  // 不能只留"有变更"的轮次：quiet 记录（根内没变、但执行过写操作）
  // 正是回答"它是不是动了别的地方"的唯一线索。
  const parts = [renderHistory(filtered)];
  parts.push('---');
  parts.push(renderTurnReport(filtered[0], { maskHome: deps.cfg.maskHome, corrupt: stats.corruptLines, maxEntries: deps.cfg.maxEntries }));
  const symptoms = detectSymptoms(filtered[0].changes || [], { roots: filtered[0].roots || [] });
  if (symptoms.length === 0) parts.push('\n（这份记录里没有匹配到已知症状）');
  return clampText(parts.join('\n\n'));
}
