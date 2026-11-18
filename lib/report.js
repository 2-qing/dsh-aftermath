/**
 * 报告渲染。纯字符串拼装，无 I/O，方便单测与后续换 UI。
 *
 * 输出的底线：不确定的事不说成确定的。
 * - certain/likely/window/unattributed 四档全部显式标注；
 * - 归因不到就写“shell 行为，无法逐文件归因”，并列出本轮命令原文供人自己看。
 */
import { CONFIDENCE_LABEL, CONFIDENCE_MARK, CONFIDENCE_ORDER, summarizeConfidence } from './attribution.js';
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
  if (s.startsWith('session-')) return `#${s.slice(8)}`;
  const compact = s.replace(/[^0-9a-zA-Z_-]/g, '');
  return compact.slice(0, 8) || s.slice(0, 8);
}

export function renderChatLine(record) {
  const counts = record?.counts || {};
  const total = counts.total || 0;
  if (total === 0) return '本轮未观测到文件变更。';
  const parts = [];
  for (const kind of ['deleted', 'created', 'modified', 'moved']) {
    const n = counts[kind] || 0;
    if (n > 0) parts.push(`${KIND_LABEL[kind]} ${n}`);
  }
  const weak = (counts.confidence?.window || 0) + (counts.confidence?.unattributed || 0);
  const tail = weak > 0 ? `，其中 ${weak} 处仅时间窗可对应` : '';
  return `本轮观测到 ${total} 处文件变更（${parts.join(' · ')}）${tail}。\n/aftermath report 看逐条明细与归因。`;
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
        const mark = CONFIDENCE_MARK[attr.confidence] || '？';
        const label = CONFIDENCE_LABEL[attr.confidence] || '无法归因';
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
    lines.push(
      `| ${formatDay(record.at)} | ${shortSession(record.session)} | ${record.turn ?? '?'} | ${parts.length > 0 ? parts.join(' ') : '无'} | ${top || '—'} |`,
    );
  }
  lines.push('');
  lines.push('要逐条明细：`/aftermath report --last 1`');
  return lines.join('\n');
}
