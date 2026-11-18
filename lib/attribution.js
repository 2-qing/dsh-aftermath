/**
 * 归因：把磁盘上的“后果”对回到具体的工具调用上。
 *
 * 原则：
 * - 只认证据，不做推断式断言。证据不足就降级，降到最低叫 unattributed（明说归不了因）。
 * - 只读调用不解释任何变更：`Get-Content C:\...\a.txt` 提到了那个文件，不等于它改过。
 * - 时间证据永远只能是 `window`，因为它解释不了“谁干的”。
 * - 时间证据分两级：先比“这次调用自己的起止区间”（窄、几乎不会错配），
 *   区间全不命中才退回整个回合的宽窗（宽，只说明“这一轮里有人动过”）。
 */
import path from 'node:path';
import { homeDir, expandHome } from './config.js';

export const CONFIDENCE_ORDER = ['certain', 'likely', 'window', 'unattributed'];

export const CONFIDENCE_LABEL = {
  certain: '确定',
  likely: '很可能',
  window: '时间窗内',
  unattributed: '无法归因',
};

export const CONFIDENCE_MARK = {
  certain: '✔',
  likely: '◐',
  window: '○',
  unattributed: '？',
};

/**
 * 时间窗这一档内部还有强弱之分，渲染时不能一律写成「时间窗内」：
 * 命中某次调用的起止区间，比只落在整轮宽窗里要硬得多。
 * 这些标签只用于展示，不改变 confidence 的取值集合。
 */
export const HOW_LABEL = {
  'call-interval': '区间内',
  'call-interval-open': '区间内·未封口',
  'turn-window': '时间窗内',
  'mutating-call-in-turn': '时间窗内·无发生时间',
};

/** 渲染一行归因时用的标记与文字：优先按 how 细分，未知 how 退回四档标签。 */
export function confidenceLabel(attribution) {
  const confidence = attribution?.confidence;
  const mark = CONFIDENCE_MARK[confidence] || '？';
  const how = attribution?.how;
  const label = HOW_LABEL[how] || CONFIDENCE_LABEL[confidence] || '无法归因';
  return { mark, label };
}

/** 明确会改文件的工具：命中即视为写操作，哪怕参数里没有 shell 动词。 */
const WRITE_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'multi_edit', 'apply_patch', 'edit_file', 'write_file',
  'create_file', 'str_replace', 'str_replace_editor', 'notebook_edit', 'insert', 'patch',
]);

/** 明确只读的工具：它们提到路径也不构成改动证据。 */
const READ_TOOLS = new Set([
  'read', 'grep', 'glob', 'ls', 'list', 'list_dir', 'view', 'search', 'find',
  'web_fetch', 'web_search', 'vision_describe', 'vision_ocr', 'vision_bootstrap',
  'vision_detect', 'vision_ground', 'vision_colors', 'vision_crop', 'vision_pixel_diff',
  'office_convert', 'office_render', 'todo_write', 'job_list', 'job_output', 'acp_status',
]);

/** 会改变文件系统的 shell 动词。表里没有的动词不会被当成写操作。 */
const MUTATING_VERBS = [
  'remove-item', 'move-item', 'copy-item', 'rename-item', 'new-item', 'set-content',
  'add-content', 'clear-content', 'set-itemproperty', 'remove-itemproperty',
  'robocopy', 'xcopy', 'icacls', 'takeown', 'attrib', 'cipher', 'expand-archive',
  'compress-archive', 'tee', 'dd', 'rsync', 'install', '7z',
  'out-file', 'tee-object', 'export-csv', 'export-clixml',
  'del', 'erase', 'rmdir', 'rd', 'mkdir', 'md', 'move', 'copy', 'ren', 'rename',
  'rm', 'mv', 'cp', 'ln', 'touch', 'truncate', 'unlink', 'chmod', 'chown',
  'ri', 'ni', 'mi',
  'unzip', 'untar', 'tar', 'expand', 'compact', 'mklink',
  'git', 'npm', 'pnpm', 'npx', 'pip',
];

/**
 * 脚本宿主：`powershell -c "Get-Content x"` 和 `powershell -c "Remove-Item x"`
 * 长得一模一样，它们本身说明不了改不改文件。所以先看里面的动词，
 * 只有写、读都对不上时才保守地算写（宿主理论上什么都能干）。
 */
const SCRIPT_HOSTS = ['pwsh', 'powershell', 'cmd', 'bash', 'sh', 'zsh', 'wsl', 'node', 'python', 'python3'];

/** 只读动词：出现它、且这条命令里没有任何写动词时，不构成改动证据。 */
const READ_VERBS = [
  'get-content', 'get-childitem', 'get-item', 'get-itemproperty', 'test-path', 'resolve-path',
  'select-string', 'measure-object', 'get-process', 'get-service', 'where-object', 'sort-object',
  'cat', 'head', 'tail', 'less', 'more', 'type', 'dir', 'ls', 'where', 'which', 'grep', 'find',
];

const escapeVerbs = (list) => list.map((v) => v.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
const VERB_PREFIX = `(?:^|[\\s;&|("'\`])`;
const VERB_SUFFIX = `(?=[\\s;&|)"'\`]|$)`;

const MUTATING_RE = new RegExp(`${VERB_PREFIX}(${escapeVerbs(MUTATING_VERBS)})${VERB_SUFFIX}`, 'i');
const READ_VERB_RE = new RegExp(`${VERB_PREFIX}(${escapeVerbs(READ_VERBS)})${VERB_SUFFIX}`, 'i');
const SCRIPT_HOST_RE = new RegExp(`${VERB_PREFIX}(${escapeVerbs(SCRIPT_HOSTS)})${VERB_SUFFIX}`, 'i');

const PATH_KEYS = [
  'command', 'cmd', 'script', 'code', 'path', 'file_path', 'filePath', 'filepath',
  'target', 'source', 'destination', 'dest', 'src', 'dst', 'from', 'to', 'old_path',
  'new_path', 'oldPath', 'newPath', 'pattern', 'glob', 'input', 'uri', 'url',
];

const PATH_ARRAY_KEYS = ['paths', 'files', 'targets', 'sources'];

/** 引号内的整段内容（允许含空格）。 */
const QUOTED_RE = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;
/** 裸 token：到空白为止，允许 * ? 交给 glob 判定。 */
const BARE_PATH_RE = /[a-zA-Z]:[\\/][^"'`<>|;\r\n\s]*/g;
const HOME_PATH_RE = /(?:%USERPROFILE%|%HOMEDRIVE%%HOMEPATH%)[\\/][^"'`<>|;\r\n\s]*/gi;
const TILDE_PATH_RE = /(?:^|[\s"'(])(~[\\/][^"'`<>|;\r\n\s]*)/gm;
const BARE_NAME_RE = /(?:^|[\s"'(])([^\\/\s"'`<>|;,*?]+\.[a-zA-Z0-9]{1,8})(?=[\s"')]|$)/gm;
/** 输出重定向：> file / >> file / 2> file / &> file，目标可能紧贴操作符。 */
/** MSYS / Git Bash 的绝对路径：/c/Users/... 这种。 */
const MSYS_PATH_RE = /(?:^|[\s"'(])(\/[a-zA-Z](?:\/[^"'`<>|;\r\n\s]*)?)/g;
const REDIRECT_RE = /(?:^|[\s;&|])(\d?>>?|&>>?)\s*(?:"([^"]*)"|'([^']*)'|([^\s;&|<>]+))/g;

const MAX_BLOB = 12000;
const MAX_TOKENS = 80;
const MAX_TOKEN_LEN = 400;
/** 回合级宽窗：调用开始前 3s 到结束后 8s（拿不到调用结束时间时的兜底）。 */
const WINDOW_BEFORE_MS = 3000;
const WINDOW_AFTER_MS = 8000;
/** 调用区间归因的默认容差；配置项 intervalSlackMs 可改。 */
export const DEFAULT_SLACK_MS = 1500;

export function normalizePath(p) {
  if (typeof p !== 'string') return '';
  let s = expandHome(p.trim());
  if (!s) return '';
  s = s.replace(/\//g, '\\');
  s = path.win32.normalize(s);
  if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

export function samePath(a, b) {
  return normalizePath(a).toLowerCase() === normalizePath(b).toLowerCase();
}

function collectStrings(value, out, depth) {
  if (depth > 3 || out.length > 200) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 50)) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === 'object') {
    for (const key of PATH_KEYS) {
      if (key in value) collectStrings(value[key], out, depth + 1);
    }
    for (const key of PATH_ARRAY_KEYS) {
      if (key in value) collectStrings(value[key], out, depth + 1);
    }
  }
}

function parseArguments(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** 从一条 tool/call 里抽证据。纯函数。 */
export function extractEvidence(call) {
  const args = parseArguments(call?.arguments);
  const pieces = [];
  if (args && typeof args === 'object') collectStrings(args, pieces, 0);
  if (pieces.length === 0 && typeof call?.arguments === 'string') pieces.push(call.arguments);

  let blob = pieces.join('\n');
  if (blob.length > MAX_BLOB) blob = blob.slice(0, MAX_BLOB);

  const absPaths = [];
  const globs = [];
  const basenames = [];
  const seen = new Set();

  const push = (raw) => {
    const token = String(raw || '').trim().replace(/[.,;:)\]}]+$/, '');
    if (!token || token.length > MAX_TOKEN_LEN) return;
    if (absPaths.length + globs.length >= MAX_TOKENS) return;
    const expanded = token
      .replace(/^%USERPROFILE%/i, homeDir())
      .replace(/^~/, homeDir())
      // Git Bash / MSYS 的 /c/Users/... 也是绝对路径，换成 C:\Users\...
      .replace(/^\/([a-zA-Z])(?=\/|$)/, (_match, drive) => `${drive.toUpperCase()}:`);
    const norm = normalizePath(expanded);
    if (!norm) return;
    const key = norm.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (/[*?]/.test(norm)) globs.push({ raw: token, pattern: norm, regex: globToRegex(norm) });
    else absPaths.push({ raw: token, path: norm, lower: norm.toLowerCase() });
  };

  // 1) 引号内的整段优先（"C:\a b\c.txt" 这种带空格的路径只有它认得）
  let rest = blob;
  const quotedRanges = [];
  for (const match of blob.matchAll(QUOTED_RE)) {
    const content = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!content) continue;
    if (/^[a-zA-Z]:[\\/]/.test(content) || /^%USERPROFILE%/i.test(content) || /^~[\\/]/.test(content)) {
      push(content);
      quotedRanges.push([match.index, match.index + match[0].length]);
    }
  }
  if (quotedRanges.length > 0) {
    let out = '';
    let cursor = 0;
    for (const [start, end] of quotedRanges) {
      out += rest.slice(cursor, start) + ' ';
      cursor = end;
    }
    rest = out + rest.slice(cursor);
  }

  // 2) 引号外的裸 token
  for (const match of rest.matchAll(BARE_PATH_RE)) push(match[0]);
  for (const match of rest.matchAll(HOME_PATH_RE)) push(match[0]);
  for (const match of rest.matchAll(TILDE_PATH_RE)) push(match[1]);
  for (const match of rest.matchAll(MSYS_PATH_RE)) push(match[1]);

  // 3) 只有文件名（无分隔符）时单独记一份，用于“本轮唯一文件名”级归因
  for (const match of blob.matchAll(BARE_NAME_RE)) {
    const name = match[1];
    if (!name) continue;
    const lower = name.toLowerCase();
    if (lower.length < 3 || lower.length > 200) continue;
    if (!basenames.includes(lower)) basenames.push(lower);
  }

  // 3b) 输出重定向。`printf x > a.txt`、`echo hi >> log`、`cmd 2> err.txt` 都会改磁盘，
  // 但命令词本身（printf/echo/dir）不在动词表里，漏掉它们会让这类调用丢掉区间证据。
  // 操作符在引号里（`echo "a > b"`）是文本，目标本身可以是引号包着的路径。
  const quoteRanges = [];
  for (const match of blob.matchAll(QUOTED_RE)) quoteRanges.push([match.index, match.index + match[0].length]);
  const inQuotes = (index) => quoteRanges.some(([start, end]) => index >= start && index < end);

  const redirects = [];
  for (const match of blob.matchAll(REDIRECT_RE)) {
    const opIndex = match.index + match[0].indexOf(match[1]);
    if (inQuotes(opIndex)) continue;
    const target = String(match[2] ?? match[3] ?? match[4] ?? '').trim();
    if (!target) continue;
    redirects.push({ op: match[1], raw: target });
    push(target);
  }

  const excerptSource = typeof args?.command === 'string'
    ? args.command
    : typeof args?.cmd === 'string'
      ? args.cmd
      : typeof args?.script === 'string'
        ? args.script
        : typeof args?.file_path === 'string'
          ? args.file_path
          : blob;
  const excerpt = String(excerptSource || '').replace(/\s+/g, ' ').trim().slice(0, 180);

  const name = typeof call?.name === 'string' && call.name ? call.name.toLowerCase() : 'unknown';
  const verbMatch = MUTATING_RE.exec(blob);
  const readVerbMatch = READ_VERB_RE.exec(blob);
  const hostMatch = SCRIPT_HOST_RE.exec(blob);

  // 分类优先级：写工具表 → 读工具表 → shell 写动词 → 重定向 → 只读动词 → 脚本宿主。
  // 脚本宿主排在最后：它能干任何事，只有写、读都对不上时才保守地算写。
  let mutating = false;
  let source = 'none';
  let verb = null;
  if (WRITE_TOOLS.has(name)) {
    mutating = true;
    source = 'tool';
    verb = `tool:${name}`;
  } else if (READ_TOOLS.has(name)) {
    source = 'read';
  } else if (verbMatch) {
    mutating = true;
    source = 'shell';
    verb = verbMatch[1].toLowerCase();
  } else if (redirects.length > 0) {
    mutating = true;
    source = 'redirect';
    verb = redirects[0].op;
  } else if (readVerbMatch) {
    source = 'read';
    verb = readVerbMatch[1].toLowerCase();
  } else if (hostMatch) {
    mutating = true;
    source = 'shell';
    verb = hostMatch[1].toLowerCase();
  }

  return {
    callId: call?.callId ?? null,
    name,
    at: typeof call?.at === 'number' ? call.at : null,
    /** 调用开始时刻 = tool/call 的 time。 */
    startAt: typeof call?.at === 'number' ? call.at : null,
    /** 调用结束时刻 = tool/result 的 time；没等到结果就是 null。 */
    endAt: typeof call?.endAt === 'number' ? call.endAt : null,
    step: Number.isInteger(call?.step) ? call.step : null,
    parseable: args !== null,
    mutating,
    readOnly: !mutating,
    source,
    verb,
    absPaths,
    globs,
    basenames,
    redirects,
    excerpt,
  };
}

export function globToRegex(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

function isUnder(childLower, parentLower) {
  if (childLower === parentLower) return false;
  const prefix = parentLower.endsWith('\\') ? parentLower : `${parentLower}\\`;
  return childLower.startsWith(prefix);
}

function basenameLower(rel) {
  const idx = Math.max(rel.lastIndexOf('\\'), rel.lastIndexOf('/'));
  return (idx >= 0 ? rel.slice(idx + 1) : rel).toLowerCase();
}

function changeAbsPath(change) {
  if (change.abs) return change.abs;
  return path.win32.normalize(path.join(change.root, change.rel));
}

function changeTimeHint(change) {
  if (change.kind === 'created' || change.kind === 'modified') {
    const t = change.after?.mtime;
    return typeof t === 'number' && t > 0 ? t : null;
  }
  return null; // deleted 只有旧 mtime，不能当“发生时间”用
}

function stamp(change, confidence, how, evidence, index) {
  return {
    ...change,
    attribution: {
      confidence,
      how,
      callIndex: typeof index === 'number' ? index : -1,
      tool: evidence?.name ?? null,
      verb: evidence?.verb ?? null,
      excerpt: evidence?.excerpt ?? null,
    },
  };
}

/**
 * 把一次调用折成一个时间区间：`[开始 - 容差, 结束 + 容差]`。
 * 拿不到结束时间时退到回合结束时刻，再拿不到就退到固定宽窗。
 */
function intervalOf(evidence, slackMs, turnEndAt) {
  if (evidence.startAt === null) return null;
  const start = evidence.startAt - slackMs;
  const endRaw = evidence.endAt ?? turnEndAt ?? evidence.startAt + WINDOW_AFTER_MS;
  const end = Math.max(start, endRaw + slackMs);
  return { evidence, start, end, width: end - start, open: evidence.endAt === null };
}

function buildIntervals(evidences, slackMs, turnEndAt) {
  const out = [];
  for (const evidence of evidences) {
    const interval = intervalOf(evidence, slackMs, turnEndAt);
    if (interval) out.push(interval);
  }
  return out;
}

/** 命中多个区间时取最窄的那个——窄区间更可能是真正干这活的调用。 */
function narrowestIntervalAt(intervals, moment) {
  let best = null;
  for (const interval of intervals) {
    if (moment < interval.start || moment > interval.end) continue;
    if (!best || interval.width < best.width) best = interval;
  }
  return best;
}

/** 整个回合的宽窗：最早一次调用开始之前，到最晚一次调用结束之后。 */
function turnSpan(intervals) {
  if (intervals.length === 0) return null;
  let start = Infinity;
  let end = -Infinity;
  for (const interval of intervals) {
    if (interval.start < start) start = interval.start;
    if (interval.end > end) end = interval.end;
  }
  return { start: start - WINDOW_BEFORE_MS, end: end + WINDOW_AFTER_MS };
}

/**
 * 区间统计，写进报告健康度：有没有拿到结束时间、有多少区间彼此重叠。
 * 重叠多说明本轮并行调用密集，此时“区间命中”也可能不止一个候选。
 */
export function analyzeIntervals(calls, options = {}) {
  const slackMs = Number.isFinite(options.slackMs) ? Math.max(0, options.slackMs) : DEFAULT_SLACK_MS;
  const turnEndAt = Number.isFinite(options.turnEndAt) ? options.turnEndAt : null;
  const evidences = (calls || [])
    .map((call) => {
      try {
        return extractEvidence(call);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const usable = evidences.filter((e) => e.mutating);
  const intervals = buildIntervals(usable, slackMs, turnEndAt);
  let overlaps = 0;
  for (let i = 0; i < intervals.length; i += 1) {
    for (let j = i + 1; j < intervals.length; j += 1) {
      const a = intervals[i];
      const b = intervals[j];
      if (a.start <= b.end && b.start <= a.end) overlaps += 1;
    }
  }
  return {
    calls: evidences.length,
    mutating: usable.length,
    timed: intervals.length,
    closed: intervals.filter((interval) => !interval.open).length,
    overlaps,
    slackMs,
  };
}

/**
 * 给每条变更盖归因戳。
 * @param {Array} changes 来自 diff.toChangeList
 * @param {Array} calls 本轮的原始 tool/call（{callId,name,arguments,at,step,endAt}）
 * @param {object} options {slackMs 区间容差, turnEndAt 回合结束时刻}
 */
export function attributeChanges(changes, calls, options = {}) {
  const slackMs = Number.isFinite(options.slackMs) ? Math.max(0, options.slackMs) : DEFAULT_SLACK_MS;
  const turnEndAt = Number.isFinite(options.turnEndAt) ? options.turnEndAt : null;
  const evidences = (calls || [])
    .map((call) => {
      try {
        return extractEvidence(call);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  // 只读调用没有资格解释变更，先整个剔掉。
  const usable = evidences.filter((e) => e.mutating);
  const withPath = usable.filter((e) => e.absPaths.length > 0 || e.globs.length > 0);
  const intervals = buildIntervals(usable, slackMs, turnEndAt);
  const span = turnSpan(intervals);

  const basenameCount = new Map();
  for (const change of changes || []) {
    const name = basenameLower(change.rel);
    basenameCount.set(name, (basenameCount.get(name) || 0) + 1);
  }

  return (changes || []).map((change) => {
    const abs = changeAbsPath(change);
    const absLower = abs.toLowerCase();
    const name = basenameLower(change.rel);

    // 1) 绝对路径 / glob 直接命中 → certain
    for (const evidence of withPath) {
      for (const token of evidence.absPaths) {
        if (token.lower === absLower) return stamp(change, 'certain', 'exact-path', evidence, evidences.indexOf(evidence));
      }
      for (const glob of evidence.globs) {
        if (glob.regex.test(abs)) return stamp(change, 'certain', 'glob-path', evidence, evidences.indexOf(evidence));
      }
    }

    // 2) 落在“被写调用指向的目录”之下 → likely
    for (const evidence of withPath) {
      for (const token of evidence.absPaths) {
        if (isUnder(absLower, token.lower)) {
          return stamp(change, 'likely', 'under-changed-dir', evidence, evidences.indexOf(evidence));
        }
      }
    }

    // 3) 只出现文件名，且本轮该文件名唯一 → likely
    if ((basenameCount.get(name) || 0) === 1) {
      for (const evidence of usable) {
        if (evidence.basenames.includes(name)) {
          return stamp(change, 'likely', 'basename', evidence, evidences.indexOf(evidence));
        }
      }
    }

    // 4a) 落在某一次调用自己的起止区间内 → window，依据具体到那次调用
    const hint = changeTimeHint(change);
    if (hint !== null) {
      const hit = narrowestIntervalAt(intervals, hint);
      if (hit) {
        return stamp(
          change,
          'window',
          hit.open ? 'call-interval-open' : 'call-interval',
          hit.evidence,
          evidences.indexOf(hit.evidence),
        );
      }
      // 4b) 区间没命中，只说明落在整个回合的宽窗里 → 更弱，但仍标明是时间证据
      if (span && hint >= span.start && hint <= span.end) {
        return stamp(change, 'window', 'turn-window', usable[0], evidences.indexOf(usable[0]));
      }
    }
    // 4c) 删除拿不到发生时间，只能要求“本轮存在写调用”
    if (usable.length > 0) {
      return stamp(change, 'window', 'mutating-call-in-turn', usable[0], evidences.indexOf(usable[0]));
    }

    // 5) 归不了就是归不了
    return {
      ...change,
      attribution: {
        confidence: 'unattributed',
        how: evidences.length === 0 ? 'no-tool-calls' : 'no-mutating-evidence',
        callIndex: -1,
        tool: null,
        verb: null,
        excerpt: null,
      },
    };
  });
}

export function summarizeConfidence(changes) {
  const counts = { certain: 0, likely: 0, window: 0, unattributed: 0 };
  for (const change of changes || []) {
    const key = change?.attribution?.confidence;
    if (key && key in counts) counts[key] += 1;
    else counts.unattributed += 1;
  }
  return counts;
}
