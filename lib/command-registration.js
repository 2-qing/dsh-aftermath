/** 命令名冲突不启动失败：复制 purge 的降级策略（同名占用则换 fallback 名）。 */
export function registerCommand(commands, definition, fallback, warn) {
  const log = typeof warn === 'function' ? warn : () => {};
  const duplicate = (error, target) => String(error?.message || error).startsWith(`command "${target}" is already registered`);

  try {
    commands.register(definition);
    return { name: definition.name, registered: definition.name, state: 'registered' };
  } catch (error) {
    if (!duplicate(error, definition.name)) return { name: definition.name, registered: null, state: 'error', error };
    log(`[aftermath] /${definition.name} 已被其它插件占用，改用 /${fallback}`);
  }
  try {
    commands.register({ ...definition, name: fallback });
    return { name: definition.name, registered: fallback, state: 'fallback' };
  } catch (error) {
    if (!duplicate(error, fallback)) return { name: definition.name, registered: null, state: 'error', error };
    log(`[aftermath] /${fallback} 也被占用，命令未注册`);
    return { name: definition.name, registered: null, state: 'conflict' };
  }
}
