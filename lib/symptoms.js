/**
 * 症状表：用户描述的是“我的桌面图标全白了”，不是“14:32 删了三个文件”。
 * 这里把变更翻回人话，并给出可以自己复制的检查命令（只打印，绝不执行）。
 */

const RECYCLE_HINT = '回收站：Explorer 地址栏输入 shell:RecycleBinFolder';

const SHORTCUT_TARGET_CHECK = String.raw`Get-ChildItem "$env:USERPROFILE\Desktop\*.lnk" -Force | ForEach-Object {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($_.FullName)
  if (-not (Test-Path -LiteralPath $s.TargetPath)) { "目标已失效: $($_.Name) -> $($s.TargetPath)" }
}`;

const ICON_CACHE_REBUILD = 'ie4uinit.exe -show  # Win10/11 重建图标缓存（无需重启资源管理器）';

const DESKTOP_FOLDER_QUERY = String.raw`Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders' |
  Select-Object Desktop, '{374DE290-123F-4565-9164-39C4925E467B}'`;

const ONEDRIVE_CHECK = 'Get-Process OneDrive -ErrorAction SilentlyContinue | Select-Object Id, Path';

function isShortcut(rel) {
  return rel.toLowerCase().endsWith('.lnk');
}

function inRoot(change, rootId) {
  return change.rootId === rootId;
}

function pick(changes, rootId, kinds) {
  return changes.filter((change) => inRoot(change, rootId) && kinds.includes(change.kind));
}

export const SYMPTOMS = [
  {
    id: 'icons-blank',
    title: '桌面图标大面积变空白 / 变成白纸图标',
    question: '是不是图标全白了、双击没反应？',
    detect({ changes, roots }) {
      const desktop = roots.find((root) => root.id === 'desktop');
      if (!desktop) return null;
      const goneShortcuts = pick(changes, 'desktop', ['deleted', 'moved']).filter((c) => isShortcut(c.rel));
      const touchedShortcuts = pick(changes, 'desktop', ['modified']).filter((c) => isShortcut(c.rel));
      if (goneShortcuts.length === 0 && touchedShortcuts.length === 0) return null;
      const score = goneShortcuts.length * 3 + touchedShortcuts.length;
      return {
        score,
        because: goneShortcuts.length > 0
          ? `桌面有 ${goneShortcuts.length} 个快捷方式被删除或移走`
          : `桌面有 ${touchedShortcuts.length} 个快捷方式文件本身被改写`,
        checks: [
          { label: '目标失效的快捷方式（最常见的“白图标”）', command: SHORTCUT_TARGET_CHECK },
          { label: '重建图标缓存', command: ICON_CACHE_REBUILD },
          { label: '被删的快捷方式', command: `${RECYCLE_HINT}，找 .lnk 恢复` },
        ],
        note: '快捷方式文件还在、但目标路径失效时，表现为白图标；快捷方式文件被删时，表现为图标消失。两者的修法完全不同。',
      };
    },
  },
  {
    id: 'desktop-files-gone',
    title: '桌面的文件 / 文件夹不见了',
    question: '是不是桌面上少了文件或文件夹？',
    detect({ changes, roots }) {
      const desktop = roots.find((root) => root.id === 'desktop');
      if (!desktop) return null;
      const gone = pick(changes, 'desktop', ['deleted', 'moved']).filter((c) => !isShortcut(c.rel));
      if (gone.length === 0) return null;
      return {
        score: gone.length * 2,
        because: `桌面有 ${gone.length} 个非快捷方式条目被删除或移走`,
        checks: [
          { label: '先看回收站', command: RECYCLE_HINT },
          { label: '确认桌面路径有没有被改到别处', command: DESKTOP_FOLDER_QUERY },
        ],
        note: 'moved 是启发式判断（同名+同大小+时间接近），如果条目出现在下面的“移走候选”里，大概率换了个目录而不是被删。',
      };
    },
  },
  {
    id: 'downloads-files-gone',
    title: '下载目录里的文件不见了',
    question: '是不是下载的东西找不到了？',
    detect({ changes, roots }) {
      const downloads = roots.find((root) => root.id === 'downloads');
      if (!downloads) return null;
      const gone = pick(changes, 'downloads', ['deleted', 'moved']);
      if (gone.length === 0) return null;
      return {
        score: gone.length * 2,
        because: `下载目录有 ${gone.length} 个条目被删除或移走`,
        checks: [{ label: '回收站', command: RECYCLE_HINT }],
      };
    },
  },
  {
    id: 'desktop-redirected',
    title: '桌面被重定向 / 被 OneDrive 接管',
    question: '是不是桌面变成空的了、或者多出一个 OneDrive 桌面？',
    detect({ changes, roots }) {
      const desktop = roots.find((root) => root.id === 'desktop');
      const reasons = [];
      if (desktop && desktop.ok === false) reasons.push(`桌面根读不到（${desktop.error}）`);
      const ini = pick(changes, 'desktop', ['created', 'modified']).filter((c) => c.rel.toLowerCase().endsWith('desktop.ini'));
      if (ini.length > 0) reasons.push('desktop.ini 被改写（目录定制信息变动）');
      const oneDrive = changes.filter((c) => /onedrive/i.test(c.rel));
      if (oneDrive.length > 0) reasons.push(`出现了 ${oneDrive.length} 处 OneDrive 相关变更`);
      if (reasons.length === 0) return null;
      return {
        score: 2 + reasons.length,
        because: reasons.join('；'),
        checks: [
          { label: '桌面真实路径（注册表）', command: DESKTOP_FOLDER_QUERY },
          { label: 'OneDrive 是否在运行', command: ONEDRIVE_CHECK },
        ],
        note: '桌面路径被改动后，旧文件通常还在原目录里，只是资源管理器不再显示它。先查注册表再动手。',
      };
    },
  },
  {
    id: 'many-renames',
    title: '一批文件被改名 / 挪位置',
    question: '是不是文件名或位置被批量改过？',
    detect({ changes }) {
      const moved = changes.filter((c) => c.kind === 'moved');
      if (moved.length < 3) return null;
      return {
        score: moved.length,
        because: `有 ${moved.length} 个条目判定为“移动”（启发式）`,
        checks: [{ label: '逐个核对移动前后的路径', command: '见上方“移走候选”表' }],
        note: '批量移动常见于整理脚本；如果是 AI 干的，命令原文会出现在归因列的“依据”里。',
      };
    },
  },
];

/** @returns {Array} 命中的症状，按 score 降序。 */
export function detectSymptoms(changes, context) {
  const hits = [];
  for (const symptom of SYMPTOMS) {
    let hit = null;
    try {
      hit = symptom.detect({ changes, roots: context.roots || [] });
    } catch {
      hit = null;
    }
    if (hit && hit.score > 0) hits.push({ ...symptom, ...hit });
  }
  return hits.sort((a, b) => b.score - a.score);
}
