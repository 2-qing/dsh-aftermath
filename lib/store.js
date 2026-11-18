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

/**
 * 读历史。sinceMs 之前的文件整份跳过；单行坏掉只跳过那一行。
 */
export function readTurns(options = {}) {
  const sinceMs = Number.isFinite(options.sinceMs) ? options.sinceMs : 0;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 200;
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
    } catch {
      continue;
    }
    const lines = raw.split('\n');
    for (let j = lines.length - 1; j >= 0; j -= 1) {
      const line = lines[j].trim();
      if (!line) continue;
      let record = null;
      try {
        record = JSON.parse(line);
      } catch {
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
export function pruneTurns(retentionDays) {
  const days = Number.isFinite(retentionDays) ? Math.max(1, Math.floor(retentionDays)) : 7;
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const name of listTurnFiles()) {
    const dayStart = Date.parse(`${name.slice(0, 10)}T00:00:00`);
    if (!Number.isFinite(dayStart)) continue;
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
