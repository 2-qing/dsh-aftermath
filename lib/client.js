/**
 * dsh-aftermath 的浏览器侧：Plugins 页里的一张配置卡片。
 *
 * 只做一件事——让「开关」和「设置」不用改 yml 也不用重启：
 *   · 总开关 enabled（关掉后不再快照、不再记录，命令仍可读历史）
 *   · 观测根 roots（内置标识或绝对路径，一行一个）
 *   · 递归深度 depth / 归档保留天数 retentionDays / 路径打码 maskHome
 *
 * 三条稳定性约定：
 * 1. 所有服务都是「可选获取」：拿不到 configForms 就渲染一段说明，绝不抛。
 * 2. 卡片整体套 QuietBoundary：渲染失败只让这张卡消失，不影响设置页。
 * 3. 写入以宿主回执为准：configForms 的 set 解析为 false 代表宿主拒绝，
 *    此时如实显示失败原因，不谎报「已保存」。
 *
 * 不 import 任何 Harness 客户端包（只用注入的 react + 主题 token），
 * 因此不需要构建，直接作为 /plugins/dsh-aftermath/client.js 提供。
 */
window.__ModuleLoader__.load({
  id: 'dsh-aftermath',
  factory: function (require) {
    var React = require('react');
    var E = React.createElement;
    var useState = React.useState;
    var useEffect = React.useEffect;
    var useRef = React.useRef;

    var TAG = '[dsh-aftermath/client]';
    /** 词典命名空间（客户端自用，与行 id 无关）。 */
    var NS = 'aftermath';
    /** 行 id = 包名 = configForms 的 key。 */
    var ROW_NAMESPACE = 'dsh-aftermath';
    /** 卡片在 Plugins 页里的槽位。 */
    var SLOT = 'plugins.bundle.config';
    /** Plugins 页顶部自己的标签页：最近变更整页显示。 */
    var TAB_SLOT = 'plugins.tab';

    var zh = {
      title: '文件变更记录',
      subtitle: '每轮对话前后对观测目录做一次快照，记下新建、删除、修改的文件。只记路径、大小和修改时间，不读文件内容。',
      enable: '记录每轮的文件变更',
      enableHint: '关掉后停止记录，已有记录保留可查。',
      enableSaved: '已生效',
      enableFailed: '开关写入失败，已还原为当前状态',
      roots: '要盯着哪些地方？',
      rootsHint: '一行一个，默认已经盯着桌面、下载、文档。要盯别的目录就加一行绝对路径，例如 D:\项目。当前对话的工作目录会自动也算进来（目录太大时只看顶层）。',
      depth: '往子文件夹里看几层',
      depthHint: '0 = 只看这一层。桌面用 2 就够；调大能看得更深，但每轮扫描更慢。',
      retention: '记录留几天',
      retentionHint: '超过天数的逐轮记录会自动清掉；你手动存的报告文件保留。',
      mask: '报告里把用户名路径打码成 ~',
      followCwd: '把当前对话的工作目录也算进去',
      followCwdHint: '开着时，除上面列的目录，还会自动把当前对话的工作目录加进观测范围（目录太大只看顶层）。关掉就只看上面列的那些。',
      recordQuietTurns: '目录没变但执行过写操作时，也留一条轻记录',
      recordQuietTurnsHint: '这种情况通常是改到了观测目录之外。留一条只含命令摘要的轻记录，报告里能提示“可能改在别处”。关掉就完全不记。',
      advanced: '高级设置',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      unsaved: '有未保存的修改',
      failed: '保存失败',
      loading: '正在读取当前设置…',
      unavailable: '宿主没有为这个插件提供设置命名空间，现在只能用 yml 改配置。跑一下 /aftermath doctor 会告诉你 Config 是否导出、schema 从哪加载。',
      readonly: '当前会话只能读取设置，不能修改。',
      badDepth: '递归深度需要是 0 到 6 之间的整数。',
      badRetention: '保留天数需要是 1 到 90 之间的整数。',
      noRoots: '至少保留一个观测目录。',
      tip: '查看记录：Plugins 页标签栏点「变更记录」，或在对话里输入 /aftermath report --last 1',
      summary: '插件尚未载入。',
      tabLabel: '变更记录',
      panelTitle: '最近变更',
      panelMoved: '完整记录在新加的「变更记录」标签页里，这里只放设置。',
      panelBudget: '超出预算，只列了一部分',
      panelStorageOver: '存档体积超过提醒阈值（只提醒，不自动清理）：',
      panelHint: '本机记录的最近几轮，和对话里 /aftermath report 是同一份数据。',
      panelRefresh: '刷新',
      panelLoading: '正在读取记录…',
      panelEmpty: '还没有记录。跑一轮对话再回来。',
      panelError: '读不到记录（面板没连上）。仍可在对话里用 /aftermath report 查看。',
      panelQuiet: '这一轮观测目录内没变化，但执行过写操作——可能改在别处。',
      panelOutside: '命令提到、但不在观测目录内的路径',
      panelMore: '只列出前 20 条变更',
      panelRound: '轮',
      panelToday: '今天',
      kCreated: '新建',
      kDeleted: '删除',
      kModified: '修改',
      kMoved: '移动',
      confCertain: '确定',
      confLikely: '很可能',
      confWindow: '时间窗内',
      confUnknown: '无法归因',
      panelIncomplete: '本轮观测不完整：有目录没扫全，下面的变更列表不完整，也不标“确定”。',
      panelSkipped: '有目录读不到，被跳过：',
      panelRootMissing: '观测目录不存在：',
      panelChangesUnit: '处变更',
      panelEmptyDisabled: '记录已停用（enabled=false）。在下面打开开关才开始记录。',
      panelEmptyNoTurn: '还没有记录。跑一轮对话并动一下文件，再回来。',
      panelEmptyNoRoot: '观测目录都不存在，没东西可记。去下面「要盯着哪些地方？」里加一个存在的目录。',
      panelEmptyReadonly: '跑过几轮，但都只是问答或读文件，没动观测目录里的文件，所以没有逐条明细。',
    };
    var en = {
      title: 'File change log',
      subtitle: 'Snapshots the watched folders before and after each turn and records what was created, deleted or modified. Paths, sizes and mtimes only; file contents are never read.',
      enable: 'Record file changes for each turn',
      enableHint: 'Turning this off stops recording; existing records stay readable.',
      enableSaved: 'Applied',
      enableFailed: 'Toggle failed; reverted to the current state',
      roots: 'Where should it look?',
      rootsHint: 'One per line. Desktop, Downloads and Documents are watched by default; add an absolute path to watch anything else. The working directory of the current session is included automatically (only its top level when it is large).',
      depth: 'How deep to look',
      depthHint: '0 means top level only. Depth 2 is enough for a desktop and stays fast.',
      retention: 'Keep records for',
      retentionHint: 'Per-turn records older than this are pruned; report files are kept.',
      mask: 'Mask the user name as ~ in reports',
      followCwd: 'Also watch the current session working directory',
      followCwdHint: 'When on, the current session working directory is added too (top level only when large). Turn off to watch only the folders above.',
      recordQuietTurns: 'Keep a light note even when nothing changed but write commands ran',
      recordQuietTurnsHint: 'Usually means something changed outside the watched folders. A light note keeps the command summary so reports can hint "changed elsewhere". Turn off to skip them.',
      advanced: 'Advanced',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      unsaved: 'Unsaved changes',
      failed: 'Save failed',
      loading: 'Reading the current settings…',
      unavailable: 'The host serves no settings namespace for this plugin, so only the yml config applies. Run /aftermath doctor to see whether Config was exported and where the schema loaded from.',
      readonly: 'This session can read the settings but not change them.',
      badDepth: 'Depth must be an integer between 0 and 6.',
      badRetention: 'Keep days must be an integer between 1 and 90.',
      noRoots: 'Keep at least one watched folder.',
      tip: 'View records in the Change log tab on the Plugins page, or type /aftermath report --last 1 in a conversation.',
      summary: 'Plugin not loaded yet.',
      tabLabel: 'Change log',
      panelTitle: 'Recent changes',
      panelMoved: 'The full log lives in the new Change log tab; this card only holds settings.',
      panelBudget: 'over budget, partial list',
      panelStorageOver: 'Archive size is above the reminder threshold (reminder only, nothing is deleted):',
      panelHint: 'The latest turns recorded on this machine — the same data as /aftermath report in a conversation.',
      panelRefresh: 'Refresh',
      panelLoading: 'Reading records…',
      panelEmpty: 'No records yet. Come back after one turn.',
      panelError: 'Could not read the records (panel unreachable). /aftermath report still works in a conversation.',
      panelQuiet: 'Nothing changed inside the watched folders this turn, but write commands ran — possibly elsewhere.',
      panelOutside: 'Paths the commands mentioned outside the watched folders',
      panelMore: 'Showing the first 20 changes',
      panelRound: 'turns',
      panelToday: 'Today',
      kCreated: 'created',
      kDeleted: 'deleted',
      kModified: 'modified',
      kMoved: 'moved',
      confCertain: 'certain',
      confLikely: 'likely',
      confWindow: 'time window',
      confUnknown: 'unattributed',
      panelIncomplete: 'This turn was observed incompletely: some folders were not fully scanned, so the list below is partial and nothing is marked certain.',
      panelSkipped: 'Some folders were unreadable and skipped:',
      panelRootMissing: 'Watched folder does not exist:',
      panelChangesUnit: 'changes',
      panelEmptyDisabled: 'Recording is off (enabled=false). Turn it on below to start recording.',
      panelEmptyNoTurn: 'No records yet. Run a turn that touches a file, then come back.',
      panelEmptyNoRoot: 'None of the watched folders exist, so there is nothing to record. Add an existing folder below.',
      panelEmptyReadonly: 'Ran some turns that were only questions or reads — no watched file changed, so no detail rows.',
    };

    // ── 小工具 ────────────────────────────────────────────────────────────────

    /** 实时查词：语言切换不需要重挂载；locale 服务缺失时退回内置中文。 */
    function translatorOf(ctx) {
      return function (key) {
        try {
          var locale = ctx && typeof ctx.get === 'function' ? ctx.get('locale') : null;
          var bound = locale && typeof locale.bind === 'function' ? locale.bind(NS) : null;
          if (typeof bound === 'function') {
            var text = bound(key);
            if (typeof text === 'string' && text !== '' && text !== key) return text;
          }
        } catch (error) { /* fall through */ }
        if (typeof zh[key] === 'string') return zh[key];
        if (typeof en[key] === 'string') return en[key];
        return key;
      };
    }

    function warn(message, error) {
      try {
        console.warn(TAG + ' ' + message + ':', error && error.message ? error.message : error);
      } catch (_) { /* 控制台都没有就算了 */ }
    }

    /** 样式只出现一次；主题 token 全部走 var(--dsw-*)。 */
    function ensureStyles() {
      try {
        if (typeof document === 'undefined') return function () {};
        var id = 'dsh-aftermath-client-style';
        if (document.getElementById(id)) return function () {};
        var style = document.createElement('style');
        style.id = id;
        style.textContent = [
          '.am-card{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
          '.am-head{display:flex;flex-direction:column;gap:4px}',
          '.am-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
          '.am-sub{color:var(--dsw-alias-label-tertiary);font-size:12px}',
          '.am-row{display:flex;flex-direction:column;gap:6px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
          '.am-row-inline{flex-direction:row;align-items:flex-start;justify-content:space-between;gap:12px}',
          '.am-label{font-weight:600;color:var(--dsw-alias-label-primary)}',
          '.am-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}',
          '.am-hint-warn{color:var(--dsw-alias-state-warn-primary)}',
          '.am-input,.am-area{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
          '.am-area{min-height:72px;resize:vertical;font-family:var(--dsh-content-font-mono,ui-monospace,monospace);font-size:12px}',
          '.am-input:focus,.am-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
          '.am-check{display:flex;align-items:center;gap:8px}',
          '.am-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
          '.am-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}',
          '.am-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
          '.am-btn:disabled{opacity:.55;cursor:not-allowed}',
          '.am-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-inverted)}',
          '.am-btn-primary:hover:not(:disabled){border-color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-brand-primary)}',
          '.am-btn-primary:focus-visible{outline:2px solid var(--dsw-alias-label-primary-inverted);outline-offset:2px}',
          '.am-note{font-size:12px}',
          '.am-note-ok{color:var(--dsw-alias-state-success-primary)}',
          '.am-note-warn{color:var(--dsw-alias-state-warn-primary)}',
          '.am-note-err{color:var(--dsw-alias-state-error-primary)}',
          '.am-box{padding:12px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
          '.am-tip{color:var(--dsw-alias-label-dimmed);font-size:12px;font-family:var(--dsh-content-font-mono,ui-monospace,monospace)}',
          '.am-adv{display:flex;flex-direction:column;gap:8px}',
          '.am-adv-head{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px;user-select:none}' ,
          '.am-page{display:flex;flex-direction:column;gap:12px;padding:16px;max-width:none}',
          '.am-page .am-panel{border-left-width:3px}',
          '.am-panel{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
          '.am-panel-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
          '.am-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}',
          '.am-btn-sm{padding:3px 10px;font-size:12px}',
          '.am-turns{display:flex;flex-direction:column;gap:6px}',
          '.am-turn-block{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}',
          '.am-turn{display:flex;align-items:baseline;gap:8px;width:100%;text-align:left;padding:2px 0;border:none;background:none;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}',
          '.am-turn:hover .am-turn-sum{color:var(--dsw-alias-brand-primary)}',
          '.am-turn-time{font-family:var(--dsh-content-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
          '.am-turn-date{font-family:var(--dsh-content-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
          '.am-turn-sess{font-family:var(--dsh-content-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-tertiary)}',
          '.am-turn-turn{font-family:var(--dsh-content-font-mono,ui-monospace,monospace);font-size:12px;color:var(--dsw-alias-label-secondary)}',
          '.am-turn-sum{font-size:12px;color:var(--dsw-alias-label-secondary)}',
          '.am-turn-quiet{font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
          '.am-changes{display:flex;flex-direction:column;gap:2px;padding:4px 0 2px 12px}',
          '.am-change{display:flex;align-items:baseline;gap:8px;font-size:12px}',
          '.am-change-kind{color:var(--dsw-alias-label-secondary);white-space:nowrap}',
          '.am-change-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--dsh-content-font-mono,ui-monospace,monospace);color:var(--dsw-alias-label-primary)}',
          '.am-change-basis{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-family:var(--dsh-content-font-mono,ui-monospace,monospace)}',
          '.am-change-conf{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
          '.am-outside{display:flex;flex-direction:column;gap:2px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:6px}',
        ].join('\n');
        document.head.appendChild(style);
        return function () {
          try {
            var node = document.getElementById(id);
            if (node && node.parentNode) node.parentNode.removeChild(node);
          } catch (error) { /* best effort */ }
        };
      } catch (error) {
        return function () {};
      }
    }

    /** 渲染失败只让这张卡消失。 */
    function QuietBoundary() {}
    QuietBoundary.prototype = Object.create(React.Component.prototype);
    QuietBoundary.prototype.constructor = QuietBoundary;
    QuietBoundary.state = { failed: false };
    QuietBoundary.getDerivedStateFromError = function () { return { failed: true }; };
    QuietBoundary.prototype.componentDidCatch = function (error) {
      warn('card render failed', error);
    };
    QuietBoundary.prototype.render = function () {
      if (this.state && this.state.failed) return null;
      return this.props.children;
    };

    // ── 快照读取 ──────────────────────────────────────────────────────────────

    var EMPTY_SNAPSHOT = { status: 'loading', value: {}, writable: false };

    function readSnapshot(scope) {
      try {
        if (!scope || typeof scope.getSnapshot !== 'function') return { status: 'unavailable', value: {}, writable: false };
        var snap = scope.getSnapshot();
        if (!snap || typeof snap !== 'object') return { status: 'unavailable', value: {}, writable: false };
        return {
          status: typeof snap.status === 'string' ? snap.status : 'ready',
          value: snap.value && typeof snap.value === 'object' ? snap.value : {},
          writable: snap.writable !== false,
          error: snap.error,
        };
      } catch (error) {
        warn('getSnapshot failed', error);
        return { status: 'unavailable', value: {}, writable: false };
      }
    }

    var DEFAULT_ROOTS = 'desktop\ndownloads\ndocuments';
/** 需要「保存」按钮写入的字段（总开关是即时写入，不在此列）。 */
var SAVE_KEYS = ['roots', 'depth', 'retentionDays', 'maskHome', 'recordQuietTurns', 'followCwd'];

/**
 * 哪些字段与宿主当前值不同。
 * 两边都归一成「填写表单时的种子值」再比较：宿主没有 schemastery 时
 * snap.value 会缺 depth/retentionDays/maskHome 这些键，直接比对会把
 * 用户的修改当成「没改」而谎报已保存；seedDraft 会给缺省键套默认值。
 */
function diffFields(fields, value) {
  var a = seedDraft(fields);
  var b = seedDraft(value);
  var out = [];
  for (var i = 0; i < SAVE_KEYS.length; i += 1) {
    var key = SAVE_KEYS[i];
    if (!sameValue(a[key], b[key])) out.push(key);
  }
  return out;
}

    function rootsToText(value) {
      if (!Array.isArray(value)) return DEFAULT_ROOTS;
      var lines = [];
      for (var i = 0; i < value.length; i += 1) {
        if (typeof value[i] === 'string' && value[i].trim() !== '') lines.push(value[i].trim());
      }
      return lines.length > 0 ? lines.join('\n') : DEFAULT_ROOTS;
    }

    function textToRoots(text) {
      var parts = String(text === undefined || text === null ? '' : text).split(/\r?\n/);
      var out = [];
      var seen = {};
      for (var i = 0; i < parts.length; i += 1) {
        var item = parts[i].trim();
        if (item === '') continue;
        var dedupe = item.toLowerCase();
        if (seen[dedupe]) continue;
        seen[dedupe] = true;
        out.push(item);
      }
      return out;
    }

    function seedDraft(value) {
      var v = value && typeof value === 'object' ? value : {};
      return {
        enabled: v.enabled !== false,
        roots: rootsToText(v.roots),
        depth: String(typeof v.depth === 'number' ? v.depth : 2),
        retentionDays: String(typeof v.retentionDays === 'number' ? v.retentionDays : 7),
        maskHome: v.maskHome !== false,
        recordQuietTurns: v.recordQuietTurns !== false,
        followCwd: v.followCwd !== false,
      };
    }

    /** 校验草稿；返回 {ok, fields, error}。 */
    function validateDraft(t, draft) {
      var depth = Number(draft.depth);
      if (!Number.isInteger(depth) || depth < 0 || depth > 6) return { ok: false, error: t('badDepth') };
      var retention = Number(draft.retentionDays);
      if (!Number.isInteger(retention) || retention < 1 || retention > 90) return { ok: false, error: t('badRetention') };
      var roots = textToRoots(draft.roots);
      if (roots.length === 0) return { ok: false, error: t('noRoots') };
      return {
        ok: true,
        fields: {
          enabled: draft.enabled === true,
          roots: roots,
          depth: depth,
          retentionDays: retention,
          maskHome: draft.maskHome === true,
          recordQuietTurns: draft.recordQuietTurns === true,
          followCwd: draft.followCwd === true,
        },
      };
    }

    function sameValue(a, b) {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch (error) {
        return false;
      }
    }

    /**
     * 「最近变更」面板：给 Plugins 详情页用的一块只读视图。
     *
     * 为什么不用会话命令：插件详情页没有会话，斜杠命令跑不起来。
     * 所以数据来自 Host 注册的只读路由（/aftermath/recent），这里只负责取和画。
     */
    const PANEL_ENDPOINT = '/aftermath/recent';

    const KIND_KEY = {
      created: 'kCreated',
      deleted: 'kDeleted',
      modified: 'kModified',
      moved: 'kMoved',
    };

    const CONF_KEY = {
      certain: 'confCertain',
      likely: 'confLikely',
      window: 'confWindow',
      unattributed: 'confUnknown',
    };

    const CONF_MARK = {
      certain: '✔',
      likely: '◐',
      window: '○',
      unattributed: '？',
    };

    function panelClock(value) {
      if (typeof value !== 'string') return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '—';
      const pad = (n) => String(n).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    /** 一轮的「删除 2 · 新建 1」摘要；没有变更就返回空串，由调用方决定文案。 */
    function fmtBytes(bytes) {
      const n = Number(bytes) || 0;
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }

    function panelSummary(turn, t) {
      const counts = turn?.counts || {};
      const parts = [];
      for (const kind of ['deleted', 'created', 'modified', 'moved']) {
        const n = counts[kind] || 0;
        if (n > 0) parts.push(`${t(KIND_KEY[kind] || 'kModified')} ${n}`);
      }
      return parts.join(' · ');
    }

    /** 一轮只显示 HH:MM，日期另外一行（诚信：行里别把「今天 14:30」这种含糊时间给小白看）。 */
    function panelDate(value) {
      if (typeof value !== 'string') return '';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return `${date.getMonth() + 1}/${date.getDate()}`;
    }

    /** session id 的前 8 位，用来在面板里区分「哪次对话」。 */
    function shortSession(sessionId) {
      const raw = String(sessionId || '');
      if (!raw) return null;
      const rest = raw.replace(/^session-/, '');
      return rest.split('-')[0].slice(0, 8) || null;
    }

    /** 依据列：tool · verb（与报告里的「依据」列一致；how 已由置信度承载）。 */
    function changeBasis(change) {
      const parts = [];
      if (change.tool) parts.push(change.tool);
      if (change.verb) parts.push(change.verb);
      return parts.join(' · ');
    }

    /** 被删条目的回收站三态：可恢复 / 不在回收站 / 无法判定。 */
    function recycleMarkOf(status) {
      if (status === 'restorable') return ' ♻';
      if (status === 'not-in-recycle') return ' ✗';
      if (status === 'unknown') return ' ?';
      return '';
    }

    /** 空态四因：开关没开 / 根不存在 / 跑过但只读 / 真没跑过。 */
    function emptyText(data, t) {
      if (!data) return t('panelEmpty');
      if (data.enabled === false) return t('panelEmptyDisabled');
      const roots = Array.isArray(data.roots) ? data.roots : [];
      const anyRootExists = roots.some((root) => root.exists !== false);
      if (roots.length > 0 && !anyRootExists) return t('panelEmptyNoRoot');
      const metaTurns = (data.meta && data.meta.turnsToday) || 0;
      if (metaTurns > 0) return t('panelEmptyReadonly');
      return t('panelEmptyNoTurn');
    }

    function Panel(props) {
      const t = props.t;
      const stateHook = useState({ status: 'loading', data: null, error: null });
      const view = stateHook[0];
      const setView = stateHook[1];

      const openHook = useState(null);
      const open = openHook[0];
      const setOpen = openHook[1];

      const load = () => {
        setView({ status: 'loading', data: null, error: null });
        try {
          if (typeof fetch !== 'function') {
            setView({ status: 'error', data: null, error: 'no-fetch' });
            return;
          }
          fetch(PANEL_ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } })
            .then((response) => {
              if (!response || !response.ok) throw new Error('http ' + (response ? response.status : '?'));
              return response.json();
            })
            .then((data) => setView({ status: 'ready', data, error: null }))
            .catch((error) => setView({ status: 'error', data: null, error: String((error && error.message) || error) }));
        } catch (error) {
          setView({ status: 'error', data: null, error: String((error && error.message) || error) });
        }
      };

      useEffect(() => {
        load();
      }, []);

      const turns = view.status === 'ready' && Array.isArray(view.data?.turns) ? view.data.turns : [];
      const totals = (view.status === 'ready' && view.data?.totals) || { todayTurns: 0, todayChanges: 0 };
      const outside = view.status === 'ready' && Array.isArray(view.data?.outside) ? view.data.outside : [];
      const storage = (view.status === 'ready' && view.data?.storage) || null;

      const head = E('div', { className: 'am-panel-head' },
        E('div', null,
          E('div', { className: 'am-panel-title' }, t('panelTitle')),
          E('div', { className: 'am-hint' }, t('panelHint')),
          storage && storage.over === true
            ? E('div', { className: 'am-hint am-hint-warn' }, t('panelStorageOver') + ' ' + fmtBytes(storage.bytes) + ' / ' + storage.warnMB + ' MB')
            : null),
        E('button', {
          type: 'button',
          className: 'am-btn am-btn-sm',
          disabled: view.status === 'loading',
          onClick: load,
        }, view.status === 'loading' ? t('panelLoading') : t('panelRefresh')));

      let body;
      if (view.status === 'loading') {
        body = E('div', { className: 'am-hint' }, t('panelLoading'));
      } else if (view.status === 'error') {
        body = E('div', { className: 'am-note am-note-warn' }, t('panelError'));
      } else if (turns.length === 0) {
        body = E('div', { className: 'am-hint' }, emptyText(view.data, t));
      } else {
        const blocks = turns.map((turn, index) => {
          const isOpen = open === index;
          const quiet = turn.kind === 'quiet';
          const summary = panelSummary(turn, t) + (turn.truncated === true ? ' · ' + t('panelBudget') : '');
          const day = panelDate(turn.at);
          const sess = shortSession(turn.session);
          const rows = [
            E('button', {
              type: 'button',
              key: 'head',
              className: isOpen ? 'am-turn am-turn-open' : 'am-turn',
              onClick: () => setOpen(isOpen ? null : index),
            },
            E('span', { key: 'clock', className: 'am-turn-time' }, panelClock(turn.at)),
            day ? E('span', { key: 'date', className: 'am-turn-date' }, day) : null,
            sess ? E('span', { key: 'sess', className: 'am-turn-sess' }, '#' + sess) : null,
            E('span', { key: 'turn', className: 'am-turn-turn' }, '#' + (turn.turn === null || turn.turn === undefined ? '?' : turn.turn)),
            E('span', { key: 'sum', className: quiet ? 'am-turn-quiet' : 'am-turn-sum' },
              quiet ? t('panelQuiet') : summary || '—')),
          ];

          if (isOpen) {
            // 观测不完整：有根没扫全，不能把「读不到」当成「0 变更」，
            // 且变更行上的 ✔ 也要降级成 ⚠——不确定的东西不能标成确定。
            if (turn.incomplete === true) {
              rows.push(E('div', { key: 'incomplete', className: 'am-note am-note-warn' }, t('panelIncomplete')));
            }
            if (Array.isArray(turn.skipped) && turn.skipped.length > 0) {
              rows.push(E('div', { key: 'skipped', className: 'am-note am-note-warn' },
                t('panelSkipped') + ' ' + turn.skipped.map((item) => item.id || item.reason || '?').join('、')));
            }
            const changes = Array.isArray(turn.changes) ? turn.changes : [];
            if (changes.length === 0) {
              rows.push(E('div', { key: 'empty', className: 'am-hint' }, quiet ? t('panelQuiet') : '—'));
            } else {
              rows.push(E('div', { key: 'list', className: 'am-changes' },
                changes.map((change, changeIndex) => {
                  const mark = turn.incomplete === true ? '⚠' : (CONF_MARK[change.confidence] || '？');
                  const basis = changeBasis(change);
                  return E('div', { key: 'c' + changeIndex, className: 'am-change' },
                    E('span', { className: 'am-change-kind' }, mark + ' ' + t(KIND_KEY[change.kind] || 'kModified') + recycleMarkOf(change.recycle)),
                    E('span', { className: 'am-change-path' }, change.path || change.rel || ''),
                    basis ? E('span', { className: 'am-change-basis' }, basis) : null,
                    E('span', { className: 'am-change-conf' }, t(CONF_KEY[change.confidence] || 'confUnknown')));
                })));
              if (turn.changesTruncated) rows.push(E('div', { key: 'more', className: 'am-hint' }, t('panelMore')));
            }
          }

          return E('div', { key: 'turn-' + index, className: 'am-turn-block' }, rows);
        });

        // 观测根不存在时明说，别让小白以为「插件没在跑」。
        const roots = (view.status === 'ready' && Array.isArray(view.data?.roots)) ? view.data.roots : [];
        const missingRoots = roots.filter((root) => root.exists === false);

        const children = [
          E('div', { key: 'totals', className: 'am-hint' },
            t('panelToday') + ' ' + (totals.todayTurns || 0) + ' ' + t('panelRound')
            + ' · ' + (totals.todayChanges || 0) + ' ' + t('panelChangesUnit')),
        ];
        if (missingRoots.length > 0) {
          children.push(E('div', { key: 'missing', className: 'am-note am-note-warn' },
            t('panelRootMissing') + ' ' + missingRoots.map((root) => root.path || root.id || '?').join('、')));
        }
        for (const block of blocks) children.push(block);
        if (outside.length > 0) {
          children.push(E('div', { key: 'outside', className: 'am-outside' },
            E('div', { className: 'am-label' }, t('panelOutside')),
            outside.slice(0, 5).map((item, index) => E('div', { key: 'o' + index, className: 'am-change' },
              E('span', { className: 'am-change-path' }, item.path || ''),
              E('span', { className: 'am-change-conf' }, '×' + (item.count || 1))))));
        }
        body = E('div', { className: 'am-turns' }, children);
      }

      return E('div', { className: 'am-panel' }, head, body);
    }

    // ── 卡片 ──────────────────────────────────────────────────────────────────

    function ConfigCard(props) {
      var t = typeof props.t === 'function' ? props.t : translatorOf(props.ctx);
      var scope = props.scope;
      var view = props.view;

      var initial = useState(EMPTY_SNAPSHOT);
      var snap = initial[0];
      var setSnap = initial[1];

      var draftState = useState(null);
      var draft = draftState[0];
      var setDraft = draftState[1];

      var dirtyRef = useRef(false);
      var draftRef = useRef(null);
      var busyState = useState(false);
      var busy = busyState[0];
      var setBusy = busyState[1];

      var noteState = useState(null);
      var note = noteState[0];
      var setNote = noteState[1];

      // 每次渲染把最新草稿写进 ref：effect / subscribe 回调据此判断
      // 「用户是否已经动过表单」，动过就不再用宿主值覆盖他。
      draftRef.current = draft;

      useEffect(function () {
        var alive = true;
        var live = readSnapshot(scope);
        if (alive) {
          setSnap(live);
          if (live.status === 'ready' && draftRef.current === null) {
            setDraft(seedDraft(live.value));
          }
        }
        if (!scope || typeof scope.subscribe !== 'function') return function () { alive = false; };
        var unsubscribe = null;
        try {
          unsubscribe = scope.subscribe(function (next) {
            if (!alive) return;
            var liveNext = next && typeof next === 'object'
              ? { status: typeof next.status === 'string' ? next.status : 'ready', value: next.value && typeof next.value === 'object' ? next.value : {}, writable: next.writable !== false }
              : readSnapshot(scope);
            setSnap(liveNext);
            if (liveNext.status === 'ready' && !dirtyRef.current) setDraft(seedDraft(liveNext.value));
          });
        } catch (error) {
          warn('subscribe failed', error);
        }
        return function () {
          alive = false;
          try {
            if (typeof unsubscribe === 'function') unsubscribe();
          } catch (error) { /* best effort */ }
        };
      }, [scope]);

      // 页面不显示摘要视图时直接不渲染，避免多占一行。
      if (view !== 'page') return null;


      if (snap.status === 'loading') {
        return E('div', { className: 'am-card' }, E('div', { className: 'am-box' }, t('loading')));
      }
      if (snap.status !== 'ready' || !scope) {
        return E('div', { className: 'am-card' },
          E('div', { className: 'am-head' },
            E('div', { className: 'am-title' }, t('title')),
            E('div', { className: 'am-sub' }, t('subtitle'))),
          E('div', { className: 'am-box' }, t('unavailable')));
      }

      var model = draft || seedDraft(snap.value);
      var disabled = busy || snap.writable === false;
      var checked = validateDraft(t, model);
      // 「有没有未保存的修改」在渲染时按宿主当前值重算，不靠事件里手工维护的标志。
      var pendingKeys = checked.ok ? diffFields(checked.fields, snap.value) : [];
      dirtyRef.current = pendingKeys.length > 0;

      function commit(key, next) {
        if (!scope || typeof scope.set !== 'function') {
          setNote({ kind: 'err', text: t('enableFailed') });
          return Promise.resolve(false);
        }
        setBusy(true);
        setNote(null);
        var task;
        try {
          task = Promise.resolve(scope.set(key, next));
        } catch (error) {
          task = Promise.reject(error);
        }
        return task.then(function (accepted) {
          setBusy(false);
          setSnap(readSnapshot(scope));
          if (accepted === false) {
            setNote({ kind: 'err', text: t('enableFailed') });
            return false;
          }
          setNote({ kind: 'ok', text: t('enableSaved') });
          return true;
        }, function (error) {
          setBusy(false);
          setSnap(readSnapshot(scope));
          setNote({ kind: 'err', text: t('enableFailed') });
          return false;
        });
      }

      function edit(patch) {
        setNote(null);
        setDraft(Object.assign({}, model, patch));
      }

      function save() {
        if (!checked.ok) {
          setNote({ kind: 'err', text: checked.error });
          return;
        }
        var fields = checked.fields;
        var pending = diffFields(fields, snap.value);
        if (pending.length === 0) {
          dirtyRef.current = false;
          setNote({ kind: 'ok', text: t('saved') });
          return;
        }
        setBusy(true);
        setNote(null);
        var index = 0;
        var failedKey = null;

        function step() {
          if (index >= pending.length) return Promise.resolve(true);
          var key = pending[index];
          index += 1;
          var task;
          try {
            task = Promise.resolve(scope.set(key, fields[key]));
          } catch (error) {
            task = Promise.reject(error);
          }
          return task.then(function (accepted) {
            if (accepted === false) {
              failedKey = key;
              return false;
            }
            return step();
          });
        }

        // 逐字段写入：任何一个被宿主拒绝都停在这里，后面的不再写，也不谎报成功。
        step().then(function (ok) {
          setBusy(false);
          setSnap(readSnapshot(scope));
          if (ok === true) {
            dirtyRef.current = false;
            setDraft(null);
            setNote({ kind: 'ok', text: t('saved') });
          } else {
            var reason = t('failed') + (failedKey ? ' (' + failedKey + ')' : '');
            setNote({ kind: 'err', text: reason });
          }
        }, function (error) {
          setBusy(false);
          setSnap(readSnapshot(scope));
          setNote({ kind: 'err', text: t('failed') + ': ' + (error && error.message ? error.message : String(error)) });
        });
      }

      var noteClass = 'am-note';
      if (note) {
        if (note.kind === 'ok') noteClass = 'am-note am-note-ok';
        else if (note.kind === 'warn') noteClass = 'am-note am-note-warn';
        else noteClass = 'am-note am-note-err';
      }

      return E('div', { className: 'am-card' },
        E('div', { className: 'am-head' },
          E('div', { className: 'am-title' }, t('title')),
          E('div', { className: 'am-sub' }, t('subtitle'))),

        // 记录列表在 Plugins 页的「变更记录」标签页里，卡片只放设置
        E('div', { className: 'am-row' },
          E('div', { className: 'am-hint' }, t('panelMoved'))),

        E('div', { className: 'am-row am-row-inline' },
          E('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            E('div', { className: 'am-label' }, t('enable')),
            E('div', { className: 'am-hint' }, t('enableHint'))),
          E('label', { className: 'am-check' },
            E('input', {
              type: 'checkbox',
              checked: model.enabled === true,
              disabled: disabled,
              onChange: function (event) {
                var next = event && event.target ? event.target.checked : false;
                setDraft(Object.assign({}, model, { enabled: next }));
                commit('enabled', next).then(function (ok) {
                  if (ok === false) {
                    setDraft(Object.assign({}, model, { enabled: snap.value && snap.value.enabled !== false }));
                  }
                });
              },
            }))),

        E('div', { className: 'am-row' },
          E('div', { className: 'am-label' }, t('roots')),
          E('textarea', {
            className: 'am-area',
            value: model.roots,
            disabled: disabled,
            spellCheck: false,
            onChange: function (event) {
              edit({ roots: event && event.target ? event.target.value : '' });
            },
          }),
          E('div', { className: 'am-hint' }, t('rootsHint'))),

        E('details', { className: 'am-adv' },
          E('summary', { className: 'am-adv-head' }, t('advanced')),

          E('div', { className: 'am-row' },
          E('div', { className: 'am-label' }, t('depth')),
          E('input', {
            className: 'am-input',
            type: 'number',
            min: 0,
            max: 6,
            step: 1,
            value: model.depth,
            disabled: disabled,
            onChange: function (event) {
              edit({ depth: event && event.target ? event.target.value : '0' });
            },
          }),
          E('div', { className: 'am-hint' }, t('depthHint'))),

        E('div', { className: 'am-row' },
          E('div', { className: 'am-label' }, t('retention')),
          E('input', {
            className: 'am-input',
            type: 'number',
            min: 1,
            max: 90,
            step: 1,
            value: model.retentionDays,
            disabled: disabled,
            onChange: function (event) {
              edit({ retentionDays: event && event.target ? event.target.value : '7' });
            },
          }),
          E('div', { className: 'am-hint' }, t('retentionHint'))),

        E('div', { className: 'am-row am-row-inline' },
          E('div', { className: 'am-label' }, t('mask')),
          E('label', { className: 'am-check' },
            E('input', {
              type: 'checkbox',
              checked: model.maskHome === true,
              disabled: disabled,
              onChange: function (event) {
                edit({ maskHome: event && event.target ? event.target.checked : true });
              },
            })))),

        E('div', { className: 'am-row am-row-inline' },
          E('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            E('div', { className: 'am-label' }, t('followCwd')),
            E('div', { className: 'am-hint' }, t('followCwdHint'))),
          E('label', { className: 'am-check' },
            E('input', {
              type: 'checkbox',
              checked: model.followCwd === true,
              disabled: disabled,
              onChange: function (event) {
                edit({ followCwd: event && event.target ? event.target.checked : true });
              },
            }))),

        E('div', { className: 'am-row am-row-inline' },
          E('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
            E('div', { className: 'am-label' }, t('recordQuietTurns')),
            E('div', { className: 'am-hint' }, t('recordQuietTurnsHint'))),
          E('label', { className: 'am-check' },
            E('input', {
              type: 'checkbox',
              checked: model.recordQuietTurns === true,
              disabled: disabled,
              onChange: function (event) {
                edit({ recordQuietTurns: event && event.target ? event.target.checked : true });
              },
            }))),

        E('div', { className: 'am-foot' },
          E('button', {
            type: 'button',
            className: 'am-btn am-btn-primary',
            disabled: disabled,
            onClick: save,
          }, busy ? t('saving') : t('save')),
          note ? E('span', { className: noteClass }, note.text) : null,
          !note && pendingKeys.length > 0 ? E('span', { className: 'am-note am-note-warn' }, t('unsaved')) : null,
          snap.writable === false ? E('span', { className: 'am-note am-note-warn' }, t('readonly')) : null),

        E('div', { className: 'am-tip' }, t('tip')));
    }


    function CardWithBoundary(props) {
      return E(QuietBoundary, null, E(ConfigCard, props));
    }

    /** 整页版：Plugins 页的「变更记录」标签页，内容就是同一个 Panel，只是外框换成整页。 */
    function PanelPage(props) {
      var t = typeof props.t === 'function' ? props.t : translatorOf(props.ctx);
      return E('div', { className: 'am-page' }, E(Panel, { t: t }));
    }

    function PanelPageWithBoundary(props) {
      return E(QuietBoundary, null, E(PanelPage, props));
    }

    // ── 插件 ──────────────────────────────────────────────────────────────────

    var exports = { name: 'dsh-aftermath/client', inject: ['locale', 'slots'], apply: function (ctx) {
      var scope = null;
      try {
        ctx.inject(['configForms'], function (fctx) {
          try {
            var forms = fctx && fctx.configForms;
            if (forms && typeof forms.get === 'function') scope = forms.get(ROW_NAMESPACE);
          } catch (error) {
            warn('configForms acquisition failed', error);
          }
        });
      } catch (error) {
        warn('configForms wiring failed', error);
      }

      ctx.effect(function () {
        var disposers = [ensureStyles()];
        try {
          var disposeDict = ctx.locale.register(NS, { zh: zh, en: en });
          if (typeof disposeDict === 'function') disposers.push(disposeDict);
        } catch (error) {
          warn('dictionary registration failed', error);
        }
        return function () {
          for (var i = 0; i < disposers.length; i += 1) {
            try {
              if (typeof disposers[i] === 'function') disposers[i]();
            } catch (error) { /* best effort */ }
          }
        };
      }, 'dsh-aftermath: styles, dictionaries');

      try {
        var slots = ctx.slots;
        if (!slots || typeof slots.inject !== 'function') {
          warn('slots unavailable; settings card idle');
          return;
        }
        slots.inject(SLOT, function () {
          return slots.register({
            name: SLOT,
            key: ROW_NAMESPACE,
            locale: NS,
            inject: function () {
              // scope 可能是 apply 时还没就绪的服务：每次取 props 时再尽力补一次，
              // 拿不到就保持 null，卡片会显示「宿主没有提供设置命名空间」。
              var live = scope;
              if (!live) {
                try {
                  var forms = typeof ctx.get === 'function' ? ctx.get('configForms') : null;
                  if (forms && typeof forms.get === 'function') live = forms.get(ROW_NAMESPACE);
                } catch (error) { /* 保持 null */ }
              }
              return { scope: live, ctx: ctx };
            },
          }, CardWithBoundary);
        });

        // 详情页里卡片永远在 README 之下（宿主槽位契约如此），所以再给一个独立标签页：
        // 它渲染在 Plugins 页标签栏下方，不与任何插件详情混在一起。
        slots.inject(TAB_SLOT, function () {
          return slots.register({
            name: TAB_SLOT,
            id: ROW_NAMESPACE,
            order: 10,
            label: function () {
              try {
                return translatorOf(ctx)('tabLabel');
              } catch (error) {
                return 'Change log';
              }
            },
            locale: NS,
            inject: function () { return { ctx: ctx }; },
          }, PanelPageWithBoundary);
        });
      } catch (error) {
        warn('settings card registration failed', error);
      }
    } };

    return exports;
  },
});
