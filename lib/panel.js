/**
 * 面板数据：把磁盘上的记录整理成 Plugins 页「最近变更」面板吃的 JSON。
 *
 * 为什么要有这条通道：
 * `/aftermath report` 是会话命令，必须有会话才能执行；插件详情页没有会话，
 * 所以面板不能复用命令，只能走 Host 自己注册的 HTTP 路由。
 *
 * 约束：
 * - 纯函数，不碰 I/O，方便单测；
 * - 只放路径、大小、时间与归因档位，不放文件内容；
 * - 体积可控（默认 8 轮、每轮 20 条变更），面板不是审计工具。
 */
import { maskPath, maskSensitive } from './report.js';

export const PANEL_PATH = '/aftermath/recent';

const MAX_TURNS = 8;
const MAX_CHANGES = 20;
const MAX_OUTSIDE = 10;

const CONFIDENCE_ORDER = ['certain', 'likely', 'window', 'unattributed'];

function clock(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function trimChange(change, mask) {
  const attr = change?.attribution || {};
  const abs = change?.abs || (change?.root && change?.rel ? `${change.root}\\${change.rel}` : change?.rel || '');
  return {
    kind: change?.kind || 'unknown',
    path: maskPath(abs || '', mask),
    rel: maskSensitive(change?.rel || ''),
    size: Number.isFinite(change?.after?.size) ? change.after.size : Number.isFinite(change?.before?.size) ? change.before.size : null,
    mtime: clock(change?.kind === 'deleted' ? change?.before?.mtime : change?.after?.mtime),
    confidence: CONFIDENCE_ORDER.includes(attr.confidence) ? attr.confidence : 'unattributed',
    how: attr.how || null,
    tool: attr.tool || null,
    verb: attr.verb || null,
    recycle: change?.recycle?.status || null,
  };
}

function trimTurn(record, mask) {
  const counts = record?.counts || {};
  const changes = Array.isArray(record?.changes) ? record.changes : [];
  const shown = changes.slice(0, MAX_CHANGES).map((change) => trimChange(change, mask));
  // 观测不完整 = 有根没扫全（complete/ok 为 false）或条目超上限（truncated）。
  // 报告层会为它打「本轮观测不完整」警告，面板也得说，否则把「读不到」显示成「0 变更」。
  const recordRoots = Array.isArray(record?.roots) ? record.roots : [];
  const incomplete = recordRoots.some(
    (root) => root?.complete === false || root?.ok === false || root?.truncated === true,
  );
  const skipped = Array.isArray(record?.skipped) ? record.skipped : [];
  return {
    turn: Number.isInteger(record?.turn) ? record.turn : null,
    at: clock(record?.at),
    session: record?.session || null,
    kind: record?.kind === 'quiet' ? 'quiet' : 'changes',
    incomplete,
    skipped: skipped.slice(0, 4).map((item) => ({ id: item?.id || null, reason: item?.reason || null })),
    total: Number.isFinite(counts.total) ? counts.total : changes.length,
    counts: {
      created: counts.created || 0,
      deleted: counts.deleted || 0,
      modified: counts.modified || 0,
      moved: counts.moved || 0,
      confidence: CONFIDENCE_ORDER.reduce((acc, key) => {
        acc[key] = counts.confidence?.[key] || 0;
        return acc;
      }, {}),
    },
    changes: shown,
    truncated: record?.truncated === true || record?.changesTruncated === true,
    changesTruncated: changes.length > shown.length,
    callsTruncated: record?.callsTruncated === true,
    scanMs: Number.isFinite(record?.health?.scanMs) ? record.health.scanMs : null,
  };
}

/**
 * @param {object} input
 * @param {Array} input.records 最近若干轮记录（新到旧或旧到新皆可，输出统一按新的在前）
 * @param {Array} input.roots 观测根 [{id, path, exists}]
 * @param {object} input.config 归一化后的配置
 * @param {string} input.version 插件版本
 * @param {number} [input.now] 生成时刻
 * @param {number} [input.todayTurns] 今天记录轮数
 * @param {number} [input.todayChanges] 今天变更总数
 */
export function buildPanelPayload(input = {}) {
  const records = Array.isArray(input.records) ? input.records.filter(Boolean) : [];
  const roots = Array.isArray(input.roots) ? input.roots : [];
  const config = input.config || {};
  const mask = config.maskHome !== false;

  const turns = records
    .slice(0, MAX_TURNS)
    .map((record) => trimTurn(record, mask));

  const latest = records[0] || null;
  const outside = Array.isArray(latest?.outside) ? latest.outside.slice(0, MAX_OUTSIDE) : [];

  return {
    plugin: 'dsh-aftermath',
    version: typeof input.version === 'string' ? input.version : null,
    generatedAt: clock(Number.isFinite(input.now) ? input.now : Date.now()),
    enabled: config.enabled !== false,
    maskHome: mask,
    roots: roots.map((root) => ({
      id: root?.id || null,
      path: maskPath(root?.path || '', mask),
      exists: root?.exists !== false,
    })),
    totals: {
      todayTurns: Number.isFinite(input.todayTurns) ? input.todayTurns : turns.length,
      todayChanges: Number.isFinite(input.todayChanges)
        ? input.todayChanges
        : turns.reduce((sum, turn) => sum + (turn.total || 0), 0),
    },
    meta: input.meta && typeof input.meta === 'object'
      ? {
        turnsTotal: Number.isFinite(input.meta.turnsTotal) ? input.meta.turnsTotal : 0,
        turnsToday: Number.isFinite(input.meta.turnsToday) ? input.meta.turnsToday : 0,
        todayKey: typeof input.meta.todayKey === 'string' ? input.meta.todayKey : null,
        lastTurnAt: Number.isFinite(input.meta.lastTurnAt) ? input.meta.lastTurnAt : null,
      }
      : null,
    latestTurn: turns[0] || null,
    turns,
    storage: input.storage && typeof input.storage === 'object'
      ? {
        bytes: Number.isFinite(input.storage.bytes) ? input.storage.bytes : 0,
        files: Number.isFinite(input.storage.files) ? input.storage.files : 0,
        oldest: typeof input.storage.oldest === 'string' ? input.storage.oldest : null,
        newest: typeof input.storage.newest === 'string' ? input.storage.newest : null,
        warnMB: Number.isFinite(input.storage.warnMB) ? input.storage.warnMB : null,
        over: input.storage.over === true,
      }
      : null,
    outside: outside.map((item) => ({
      path: maskPath(item?.path || '', mask),
      count: Number.isFinite(item?.count) ? item.count : 1,
      tools: Array.isArray(item?.tools) ? item.tools.slice(0, 4) : [],
    })),
  };
}

/** 面板路由的响应头：本地只读数据，不缓存、不许内嵌到别处。 */
export const PANEL_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};