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

    var zh = {
      title: '文件变更记录',
      subtitle: '每轮对话前后对观测目录做一次快照，记下新建、删除、修改的文件。只记路径、大小和修改时间，不读文件内容。',
      enable: '记录每轮的文件变更',
      enableHint: '关掉后停止记录，已有记录保留可查。',
      enableSaved: '已生效',
      enableFailed: '开关写入失败，已还原为当前状态',
      roots: '观测目录',
      rootsHint: '一行一个。可写内置标识 desktop / downloads / documents / pictures / music / videos，或绝对路径。',
      depth: '递归深度',
      depthHint: '0 只看顶层。桌面用 2 足够，越大越慢。',
      retention: '保留天数',
      retentionHint: '超过天数的逐轮记录会被清掉，报告文件保留。',
      mask: '报告里把家目录打码成 ~',
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
      tip: '查看记录：在对话里输入 /aftermath report --last 1',
      summary: '插件尚未载入。',
    };
    var en = {
      title: 'File change log',
      subtitle: 'Snapshots the watched folders before and after each turn and records what was created, deleted or modified. Paths, sizes and mtimes only; file contents are never read.',
      enable: 'Record file changes for each turn',
      enableHint: 'Turning this off stops recording; existing records stay readable.',
      enableSaved: 'Applied',
      enableFailed: 'Toggle failed; reverted to the current state',
      roots: 'Watched folders',
      rootsHint: 'One per line. Use a built-in alias (desktop / downloads / documents / pictures / music / videos) or an absolute path.',
      depth: 'Recursion depth',
      depthHint: '0 means top level only. Depth 2 is enough for a desktop and stays fast.',
      retention: 'Keep days',
      retentionHint: 'Per-turn records older than this are pruned; report files are kept.',
      mask: 'Mask the home directory as ~ in reports',
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
      tip: 'To view the records, type /aftermath report --last 1 in the conversation.',
      summary: 'Plugin not loaded yet.',
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
          '.am-input,.am-area{width:100%;box-sizing:border-box;padding:7px 9px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit}',
          '.am-area{min-height:72px;resize:vertical;font-family:var(--dsh-content-font-mono,ui-monospace,monospace);font-size:12px}',
          '.am-input:focus,.am-area:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}',
          '.am-check{display:flex;align-items:center;gap:8px}',
          '.am-foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
          '.am-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit}',
          '.am-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
          '.am-btn:disabled{opacity:.55;cursor:not-allowed}',
          '.am-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-color)}',
          '.am-note{font-size:12px}',
          '.am-note-ok{color:var(--dsw-alias-state-success-primary)}',
          '.am-note-warn{color:var(--dsw-alias-state-warn-primary)}',
          '.am-note-err{color:var(--dsw-alias-state-error-primary)}',
          '.am-box{padding:12px;border-radius:8px;border:1px dashed var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}',
          '.am-tip{color:var(--dsw-alias-label-dimmed);font-size:12px;font-family:var(--dsh-content-font-mono,ui-monospace,monospace)}',
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

    var DEFAULT_ROOTS = 'desktop\ndownloads';
/** 需要「保存」按钮写入的字段（总开关是即时写入，不在此列）。 */
var SAVE_KEYS = ['roots', 'depth', 'retentionDays', 'maskHome'];

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
      } catch (error) {
        warn('settings card registration failed', error);
      }
    } };

    return exports;
  },
});
