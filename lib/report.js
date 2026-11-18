/**
 * 报告渲染。纯字符串拼装，无 I/O，方便单测与后续换 UI。
 *
 * 输出的底线：不确定的事不说成确定的。
 * - certain/likely/window/unattributed 四档全部显式标注；
 * - 归因不到就写“shell 行为，无法逐文件归因”，并列出本轮命令原文供人自己看。
 */
import { CONFIDENCE_LABEL, CONFIDENCE_MARK, CONFIDENCE_ORDER, confidenceLabel, summarizeConfidence } from './attribution.js';
import { detectSymptoms } from './symptoms.js';
import { homeDir } from './config.js';

const KIND_LABEL = {
  created: '新建',
  deleted: '删除',
  modified: '修改',
  moved: '移动',
};

function formatSize(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 路径归一化，只用于比较：统一分隔符、去尾斜杠、大小写不敏感。 */
function normalizeForCompare(value) {
  return String(value ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** path 是否落在 rootPath 之下（含等于）。 */
function isUnder(pathValue, rootPath) {
  const p = normalizeForCompare(pathValue);
  const r = normalizeForCompare(rootPath);
  if (!p || !r) return false;
  return p === r || p.startsWith(`${r}\\`);
}

/**
 * 本轮命令里提到、但不在任何观测根之下的绝对路径。
 *
 * 这是唯一能覆盖“根外发生了什么”的线索：不扫盘，只读命令行文本，
 * 所以它说的是“命令提到过”，不是“磁盘上真的变了”。
 */
export function outsideRootPaths(record) {
  const calls = Array.isArray(record?.calls) ? record.calls : [];
  const roots = Array.isArray(record?.roots) ? record.roots : [];
  const rootPaths = roots.map((root) => root?.path).filter((p) => typeof p === 'string' && p);
  const map = new Map();
  for (const call of calls) {
    const paths = Array.isArray(call?.paths) ? call.paths : [];
    if (paths.length === 0) continue;
    const label = `${call.name || 'tool'}${call.verb ? ` · ${call.verb}` : ''}`;
    for (const raw of paths) {
      if (typeof raw !== 'string' || !raw) continue;
      if (rootPaths.some((rootPath) => isUnder(raw, rootPath))) continue;
      const key = normalizeForCompare(raw);
      if (!key) continue;
      let item = map.get(key);
      if (!item) {
        item = { path: raw, count: 0, tools: [], at: call.at ?? null };
        map.set(key, item);
      }
      item.count += 1;
      if (!item.tools.includes(label)) item.tools.push(label);
    }
  }
  return [...map.values()];
}

function formatClock(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatDay(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${formatClock(ms)}`;
}

function maskPath(p, enabled) {
  if (!enabled) return p;
  const home = homeDir();
  if (!home) return p;
  if (p.toLowerCase().startsWith(home.toLowerCase())) return `~${p.slice(home.length)}`;
  return p;
}

function cell(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function absOfChange(change) {
  if (change.abs) return change.abs;
  if (change.root && change.rel) return `${change.root}\\${change.rel}`;
  return change.rel || '';
}

/**
 * 会话短标：宿主默认把 session.id 编成 `session-N`，前缀 `session-` 无区分度，
 * 只保留编号成 `#N`；人为标记（unknown/anonymous/manual-scan）原样保留；
 * 其余任意 id（含 uuid）取前 8 位。
 */
function shortSession(id) {
  const s = String(id ?? '');
  if (!s) return '—';
  if (s === 'unknown' || s === 'anonymous' || s === 'manual-scan') return s;
  if (s.startsWith('session-')) {
    // 形如 session-01c4eb63-06ec-4084-... 只取第一段，别把整串 UUID 摊在标题里
    const rest = s.slice(8);
    const head = rest.split('-')[0] || rest;
    return `#${head.slice(0, 8)}`;
  }
  const compact = s.replace(/[^0-9a-zA-Z_-]/g, '');
  return compact.slice(0, 8) || s.slice(0, 8);
}

export function renderChatLine(record) {
  const counts = record?.counts || {};
  const total = counts.total || 0;
  if (total === 0) {
    const mutating = (Array.isArray(record?.calls) ? record.calls : []).filter((call) => call.mutating).length;
    if (mutating > 0) {
      return `本轮观测根内没有文件变更，但执行过 ${mutating} 条写操作——改动可能落在观测根之外。\n/aftermath report 看它碰过哪些路径。`;
    }
    return '本轮未观测到文件变更。';
  }
  const parts = [];
  for (const kind of ['deleted', 'created', 'modified', 'moved']) {
    const n = counts[kind] || 0;
    if (n > 0) parts.push(`${KIND_LABEL[kind]} ${n}`);
  }
  const weak = (counts.confidence?.window || 0) + (counts.confidence?.unattributed || 0);
  const tail = weak > 0 ? `，其中 ${weak} 处仅时间窗可对应` : '';
  return `本轮观测到 ${total} 处文件变更（${parts.join(' · ')}）${tail}。\n/aftermath report 看逐条明细与归因。`;
}

/**
 * 报告健康度：这份报告本身可信到什么程度。
 * 只说能算出来的事实（耗时、覆盖量、区间可用性、截断），不评价、不给分。
 */
function renderHealth(record) {
  const health = record?.health;
  if (!health || typeof health !== 'object') return [];
  const confidence = record?.counts?.confidence || {};
  const total = ['certain', 'likely', 'window', 'unattributed'].reduce((sum, key) => sum + (confidence[key] || 0), 0);
  const pct = (n) => (total > 0 ? `${Math.round((n / total) * 100)}%` : '—');
  const intervals = health.intervals || {};

  const lines = [];
  lines.push('## 报告健康度');
  lines.push('');
  if (Number.isFinite(health.scanMs)) {
    lines.push(`- 快照耗时：本轮结束这次扫描 ${health.scanMs} ms，覆盖 ${health.roots ?? 0} 个根 / ${health.scanned ?? 0} 个条目`);
  }
  if (total > 0) {
    const parts = ['certain', 'likely', 'window', 'unattributed']
      .map((key) => `${CONFIDENCE_MARK[key]}${CONFIDENCE_LABEL[key]} ${confidence[key] || 0}（${pct(confidence[key] || 0)}）`);
    lines.push(`- 归因分布：${parts.join(' · ')}`);
  }
  if ((confidence.window || 0) > 0) {
    const weakList = (record?.changes || []).filter((c) => c?.attribution?.confidence === 'window');
    const inInterval = weakList.filter((c) => String(c?.attribution?.how || '').startsWith('call-interval')).length;
    if (weakList.length > 0) {
      lines.push(`- 时间证据：${inInterval} 处 mtime 落在某次调用的起止区间内，${weakList.length - inInterval} 处只落在整轮宽窗`);
    }
  }
  if (Number.isFinite(intervals.timed)) {
    if (intervals.timed > 0) {
      const open = Math.max(0, intervals.timed - (intervals.closed ?? 0));
      const openNote = open > 0 ? `，其中 ${open} 次没等到结果、区间按回合结束时刻封口` : '';
      const overlapNote = intervals.overlaps > 0
        ? `；${intervals.overlaps} 对区间重叠，重叠时取最窄的那个`
        : '';
      lines.push(
        `- 调用区间：${intervals.calls ?? 0} 次调用、${intervals.mutating ?? 0} 次写操作，`
        + `${intervals.closed ?? 0}/${intervals.timed} 拿到起止时刻（容差 ${intervals.slackMs ?? 0} ms）${openNote}${overlapNote}`,
      );
    } else {
      lines.push('- 调用区间：本轮没有可用的调用时刻，时间证据只到回合宽窗这一级');
    }
  }
  if (health.truncated) {
    lines.push(`- 未列全：本次只列出前 ${health.listed ?? 0} 条，其余 ${Math.max(0, (health.changed ?? 0) + (record?.counts?.moved || 0) - (health.listed ?? 0))} 条未逐条展开`);
  }
  lines.push('');
  return lines;
}

export function renderTurnReport(record, options = {}) {
  const maskHome = options.maskHome !== false;
  const changes = Array.isArray(record?.changes) ? record.changes : [];
  const roots = Array.isArray(record?.roots) ? record.roots : [];
  const counts = record?.counts || {};
  const confidence = counts.confidence || summarizeConfidence(changes);

  const lines = [];
  lines.push(`# 第 ${record?.turn ?? '?'} 轮 · ${formatDay(record?.at)} · 会话 ${shortSession(record?.session)}`);
  lines.push('');

  if (changes.length === 0) {
    lines.push(`观测范围内没有文件变更（${roots.map((r) => maskPath(r.path, maskHome)).join('、') || '无可用根'}）。`);
    const mutating = (Array.isArray(record?.calls) ? record.calls : []).filter((call) => call.mutating);
    if (mutating.length > 0) {
      lines.push('');
      lines.push(`不过这一轮执行过 ${mutating.length} 条写操作；观测根内没有变化，意味着改动可能落在根外。命令原文：`);
      lines.push('');
      for (const call of mutating.slice(0, 5)) {
        lines.push(`- \`${cell(call.name || 'tool')}\` ${cell(call.excerpt || '')}`);
      }
      if (mutating.length > 5) lines.push(`- ……另有 ${mutating.length - 5} 条未列出`);
    } else {
      lines.push('');
      lines.push('这一轮也没有执行过写操作（可能只是问了几句或读了文件）。');
    }
    lines.push('');
  } else {
    const parts = [];
    for (const kind of ['deleted', 'created', 'modified', 'moved']) {
      const n = counts[kind] || 0;
      if (n > 0) parts.push(`${KIND_LABEL[kind]} ${n}`);
    }
    lines.push(`共 ${counts.total ?? changes.length} 处变更：${parts.join(' · ')}`);
    lines.push('');
    lines.push(
      `归因：${CONFIDENCE_ORDER.map((key) => `${CONFIDENCE_MARK[key]}${CONFIDENCE_LABEL[key]} ${confidence[key] || 0}`).join(' · ')}`,
    );
    lines.push('');

    const byRoot = new Map();
    for (const change of changes) {
      const key = change.rootId || change.root || '?';
      if (!byRoot.has(key)) byRoot.set(key, []);
      byRoot.get(key).push(change);
    }

    for (const [rootId, list] of byRoot) {
      const root = roots.find((r) => r.id === rootId) || { id: rootId, path: list[0]?.root };
      lines.push(`## ${rootId}（${maskPath(root.path || '', maskHome)}）`);
      lines.push('');
      lines.push('| 变更 | 条目 | 大小 | 时间 | 归因 | 依据 |');
      lines.push('| --- | --- | --- | --- | --- | --- |');
      for (const change of list) {
        const attr = change.attribution || { confidence: 'unattributed' };
        const { mark, label } = confidenceLabel(attr);
        const when = change.kind === 'deleted'
          ? formatClock(change.before?.mtime)
          : formatClock(change.after?.mtime);
        const size = change.kind === 'deleted' ? change.before?.size : change.after?.size;
        const basis = attr.tool
          ? `${attr.tool}${attr.verb ? ` · ${attr.verb}` : ''}${attr.how ? ` (${attr.how})` : ''}`
          : attr.how || '—';
        lines.push(
          `| ${KIND_LABEL[change.kind] || change.kind} | ${cell(change.rel)} | ${formatSize(size)} | ${when} | ${mark}${label} | ${cell(basis)} |`,
        );
      }
      lines.push('');
    }

    const moved = changes.filter((change) => change.kind === 'moved');
    if (moved.length > 0) {
      lines.push('## 移走候选（启发式：同名 + 同大小 + 时间接近）');
      lines.push('');
      for (const change of moved) {
        const delta = Number.isFinite(change.mtimeDeltaMs) ? `，mtime 差 ${change.mtimeDeltaMs} ms` : '';
        lines.push(`- ${cell(change.movedFrom)} → ${cell(change.rel)}${delta}`);
      }
      lines.push('');
    }

    const weak = changes.filter((change) => {
      const key = change.attribution?.confidence;
      return key === 'window' || key === 'unattributed' || !key;
    });
    if (weak.length > 0) {
      lines.push('## 归因不到的部分');
      lines.push('');
      lines.push(`${weak.length} 处变更只能落到时间窗或无法归因。这类变更通常来自 shell / pwsh 的间接行为，`);
      lines.push('**无法逐文件归因**——本插件不做这种断言。以下是本轮执行过的命令原文，供你自己比对：');
      lines.push('');
      for (const call of (record.calls || []).slice(0, 5)) {
        lines.push(`- \`${cell(call.name || 'tool')}\` ${cell(call.excerpt || '')}`);
      }
      if ((record.calls || []).length === 0) lines.push('- （本轮没有工具调用记录）');
      lines.push('');
    }
  }

  const outside = outsideRootPaths(record);
  if (outside.length > 0) {
    lines.push('## 命令提到、但不在观测根内的路径');
    lines.push('');
    lines.push('这些路径出现在本轮命令里，但不在观测范围内；插件没看过它们的磁盘状态，下面只来自命令行文本。');
    lines.push('');
    for (const item of outside.slice(0, 20)) {
      const times = item.count > 1 ? ` ×${item.count}` : '';
      lines.push(`- \`${cell(maskPath(item.path, maskHome))}\`${times} · ${cell(item.tools.slice(0, 3).join('、'))}`);
    }
    if (outside.length > 20) lines.push(`- ……另有 ${outside.length - 20} 条未列出`);
    lines.push('');
  }

  for (const line of renderHealth(record)) lines.push(line);

  const skipped = Array.isArray(record?.skipped) ? record.skipped : [];
  if (skipped.length > 0) {
    lines.push('## 跳过的根（读不到 ≠ 被删光）');
    lines.push('');
    for (const item of skipped) lines.push(`- ${item.id || '?'}：${item.reason || 'unreadable'}`);
    lines.push('');
  }

  const symptoms = options.symptoms === false
    ? []
    : detectSymptoms(changes, { roots });
  if (symptoms.length > 0) {
    lines.push('## 你看到的现象可能对应');
    lines.push('');
    for (const symptom of symptoms.slice(0, 3)) {
      lines.push(`### ${symptom.title}`);
      lines.push('');
      lines.push(`命中理由：${symptom.because}`);
      if (symptom.note) lines.push(`说明：${symptom.note}`);
      lines.push('');
      for (const check of symptom.checks || []) {
        lines.push(`- ${check.label}`);
        lines.push('');
        lines.push('```powershell');
        lines.push(check.command);
        lines.push('```');
        lines.push('');
      }
    }
  }

  lines.push('---');
  lines.push('只记录路径、大小、时间，不读文件内容；不自动还原、不代为执行任何命令。');
  return lines.join('\n');
}

export function renderHistory(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  if (list.length === 0) return '还没有历史记录。跑一轮对话后再来看。';
  const lines = [];
  lines.push(`# 最近 ${list.length} 轮变更`);
  lines.push('');
  lines.push('| 时间 | 会话 | 轮 | 变更 | 主要归因 |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const record of list) {
    const counts = record.counts || {};
    const parts = [];
    for (const kind of ['deleted', 'created', 'modified', 'moved']) {
      const n = counts[kind] || 0;
      if (n > 0) parts.push(`${KIND_LABEL[kind]}${n}`);
    }
    const confidence = counts.confidence || {};
    const top = CONFIDENCE_ORDER
      .filter((key) => (confidence[key] || 0) > 0)
      .map((key) => `${CONFIDENCE_MARK[key]}${confidence[key]}`)
      .join(' ');
    const mutating = (Array.isArray(record.calls) ? record.calls : []).filter((c) => c.mutating).length;
    const changeCell = parts.length > 0
      ? parts.join(' ')
      : mutating > 0 ? `0（写过 ${mutating} 条命令，根外？）` : '无';
    lines.push(
      `| ${formatDay(record.at)} | ${shortSession(record.session)} | ${record.turn ?? '?'} | ${changeCell} | ${top || '—'} |`,
    );
  }
  lines.push('');
  lines.push('要逐条明细：`/aftermath report --last 1`');
  return lines.join('\n');
}
