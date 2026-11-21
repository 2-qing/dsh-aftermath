/**
 * 落盘。全部同步小 I/O，失败一律吞掉并计数——存不下历史不该影响用户干活。
 *
 * 布局：
 *   <stateDir>/config-resolved.json    启动时解析出的根与实际参数（排障用）
 *   <stateDir>/turns/YYYY-MM-DD.ndjson 每轮一行（JSON）
 *   <stateDir>/reports/*.md            显式导出的报告
 */
import fs from 'node:fs';
import path from 'node:path';
import { stateDir } from './config.js';

function pad(n) {
  return String(n).padStart(2, '0');
}

export function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function turnsDir() {
  return path.join(stateDir(), 'turns');
}

export function reportsDir() {
  return path.join(stateDir(), 'reports');
}

export function ensureDirs() {
  const result = { ok: true, error: null };
  for (const dir of [stateDir(), turnsDir(), reportsDir()]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      result.ok = false;
      result.error = `${dir}: ${err?.code || err?.message || 'error'}`;
    }
  }
  return result;
}

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function saveResolvedConfig(config) {
  try {
    ensureDirs();
    atomicWrite(path.join(stateDir(), 'config-resolved.json'), `${JSON.stringify(config, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 诊断快照：宿主设置服务看到的命名空间（只含 ns 名与字段名，无值）。 */
export function saveSettingsProbe(probe) {
  try {
    ensureDirs();
    atomicWrite(path.join(stateDir(), 'settings-probe.json'), `${JSON.stringify(probe, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function appendTurn(record) {
  try {
    ensureDirs();
    const at = typeof record?.at === 'number' ? record.at : Date.now();
    const file = path.join(turnsDir(), `${dayKey(new Date(at))}.ndjson`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
    return file;
  } catch {
    return null;
  }
}

function listTurnFiles() {
  try {
    return fs
      .readdirSync(turnsDir())
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

const CORRUPT_LOG = 'corrupt.log';
/** 一次读取最多记多少条坏行，防止整份文件坏掉时把日志写爆。 */
const MAX_CORRUPT_LOGGED = 20;

/**
 * 坏行不只跳过，还留一份证据。
 *
 * 静默跳过对“事后倒查”是致命的：用户会以为那轮什么都没变，其实是记录读不出来。
 * 这里只记文件、行号、字节数与错误，不抄原文——原文可能含路径与命令。
 */
function logCorrupt(name, lineNo, line, error) {
  try {
    ensureDirs();
    const entry = JSON.stringify({
      at: Date.now(),
      file: name,
      line: lineNo,
      bytes: Buffer.byteLength(line, 'utf8'),
      error: String(error?.message || error || 'parse error').slice(0, 120),
    });
    fs.appendFileSync(path.join(stateDir(), CORRUPT_LOG), `${entry}\n`, 'utf8');
  } catch {
    /* 记账失败不影响读取 */
  }
}

/**
 * 读历史。sinceMs 之前的文件整份跳过；单行坏掉只跳过那一行，并计数。
 *
 * 传 options.stats 进来可以拿到本次读取的完整性统计（corruptLines / filesRead / readErrors），
 * 上层据此在 status、报告、面板里明说“这一段没读全”。
 */
export function readTurns(options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200;
  const stats = options.stats && typeof options.stats === 'object' ? options.stats : null;
  if (stats) {
    stats.corruptLines = stats.corruptLines || 0;
    stats.filesRead = stats.filesRead || 0;
    stats.readErrors = stats.readErrors || 0;
  }
  const files = listTurnFiles();
  const out = [];
  for (let i = files.length - 1; i >= 0; i -= 1) {
    if (out.length >= limit) break;
    const name = files[i];
    const dayStart = Date.parse(`${name.slice(0, 10)}T00:00:00`);
    // 文件按天命名，若该日整天早于 since 就整份跳过。
    if (Number.isFinite(dayStart) && dayStart + 86400000 < sinceMs) continue;
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(turnsDir(), name), 'utf8');
    } catch (error) {
      if (stats) stats.readErrors += 1;
      logCorrupt(name, 0, '', error);
      continue;
    }
    if (stats) stats.filesRead += 1;
    const lines = raw.split('\n');
    let logged = 0;
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j].trim();
      if (!line) continue;
      let record = null;
      try {
        record = JSON.parse(line);
      } catch (error) {
        if (stats) stats.corruptLines += 1;
        if (logged < MAX_CORRUPT_LOGGED) {
          logCorrupt(name, j + 1, line, error);
          logged += 1;
        }
        continue;
      }
      const at = typeof record?.at === 'number' ? record.at : 0;
      if (at < sinceMs) continue;
      out.push(record);
      if (out.length >= limit) break;
    }
  }
  return out;
}

function baselinePath() {
  return path.join(stateDir(), 'baseline.json');
}

/** 基线只存“最近一次观测到的完整快照”，用于 /aftermath scan 查空闲期变更。 */
export function saveBaseline(baseline) {
  try {
    ensureDirs();
    atomicWrite(baselinePath(), `${JSON.stringify(baseline)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function loadBaseline() {
  try {
    const raw = fs.readFileSync(baselinePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.roots)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeReport(name, text) {
  try {
    ensureDirs();
    const safe = String(name || 'report').replace(/[^a-zA-Z0-9._-]/g, '_');
    const file = path.join(reportsDir(), `${safe}.md`);
    atomicWrite(file, text);
    return file;
  } catch {
    return null;
  }
}

/** 保留 retentionDays 天，返回删掉的文件数。 */
/**
 * 按保留天数删整天的记录。钉住的日期一律跳过——用户想留的那次事故不能被自动清理带走。
 * @param {number} retentionDays
 * @param {{days?: string[]}} [pins]
 */
export function pruneTurns(retentionDays, pins = null) {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.floor(retentionDays)) : 7;
  const cutoff = Date.now() - days * 86400000;
  const pinned = new Set((pins && Array.isArray(pins.days) ? pins.days : []).map(String));
  let removed = 0;
  for (const name of listTurnFiles()) {
    const day = name.slice(0, 10);
    const dayStart = Date.parse(`${day}T00:00:00`);
    if (!Number.isFinite(dayStart)) continue;
    if (pinned.has(day)) continue;
    if (dayStart + 86400000 < cutoff) {
      try {
        fs.unlinkSync(path.join(turnsDir(), name));
        removed += 1;
      } catch {
        /* 删不掉就算了 */
      }
    }
  }
  return removed;
}

function pinsPath() {
  return path.join(stateDir(), 'pins.json');
}

function metaPath() {
  return path.join(stateDir(), 'meta.json');
}

/**
 * 轮次计数元数据。它回答的不是「变了哪些文件」，而是「插件有没有在跑」。
 *
 * 纯只读回合（只问答、读了文件）不会落 turns 明细——那是为了不把磁盘写满，
 * 但代价是 status / 面板会把「跑过 100 轮只读」显示成「0 轮 / 没有记录」。
 * 所以这里单独记一个计数器，无论是否落盘都 +1，让两个界面能说真话。
 */
export function readMeta() {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    return {
      turnsTotal: Number.isFinite(parsed?.turnsTotal) ? parsed.turnsTotal : 0,
      turnsToday: Number.isFinite(parsed?.turnsToday) ? parsed.turnsToday : 0,
      todayKey: typeof parsed?.todayKey === 'string' ? parsed.todayKey : null,
      lastTurnAt: Number.isFinite(parsed?.lastTurnAt) ? parsed.lastTurnAt : null,
    };
  } catch {
    return { turnsTotal: 0, turnsToday: 0, todayKey: null, lastTurnAt: null };
  }
}

export function writeMeta(meta) {
  try {
    ensureDirs();
    atomicWrite(
      metaPath(),
      `${JSON.stringify({
        turnsTotal: Number.isFinite(meta?.turnsTotal) ? meta.turnsTotal : 0,
        turnsToday: Number.isFinite(meta?.turnsToday) ? meta.turnsToday : 0,
        todayKey: typeof meta?.todayKey === 'string' ? meta.todayKey : null,
        lastTurnAt: Number.isFinite(meta?.lastTurnAt) ? meta.lastTurnAt : null,
      }, null, 2)}\n`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 读钉住的日期列表。文件不存在或坏掉都当成"没钉任何东西"，不让清理变成两套逻辑。
 */
export function readPins() {
  try {
    const parsed = JSON.parse(fs.readFileSync(pinsPath(), 'utf8'));
    const days = Array.isArray(parsed?.days) ? parsed.days : [];
    const valid = days.filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day)));
    return { days: [...new Set(valid.map(String))].sort() };
  } catch {
    return { days: [] };
  }
}

export function writePins(pins) {
  try {
    ensureDirs();
    const days = (Array.isArray(pins?.days) ? pins.days : [])
      .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(String(day)))
      .map(String);
    atomicWrite(pinsPath(), `${JSON.stringify({ days: [...new Set(days)].sort() }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 存档占了多少地方。只 stat 不读内容，用来在 status 里回答"这东西会不会把磁盘写满"。
 */
export function diskUsage() {
  const result = { dir: stateDir(), bytes: 0, files: 0, days: [], oldest: null, newest: null };
  const addFile = (file, day) => {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return;
      result.bytes += stat.size;
      result.files += 1;
      if (!day) return;
      const row = result.days.find((item) => item.day === day);
      if (row) row.bytes += stat.size;
      else result.days.push({ day, bytes: stat.size });
    } catch {
      /* 读不到就不算 */
    }
  };
  for (const name of listTurnFiles()) addFile(path.join(turnsDir(), name), name.slice(0, 10));
  for (const name of ['baseline.json', 'settings-probe.json', 'config-resolved.json', 'pins.json', CORRUPT_LOG]) {
    addFile(path.join(stateDir(), name), null);
  }
  try {
    for (const name of fs.readdirSync(reportsDir())) addFile(path.join(reportsDir(), name), null);
  } catch {
    /* 没有报告目录很正常 */
  }
  const days = result.days.map((item) => item.day).sort();
  result.days.sort((a, b) => (a.day < b.day ? 1 : -1));
  result.oldest = days[0] || null;
  result.newest = days[days.length - 1] || null;
  return result;
}
