const fmt = (level, msg, extra) => {
  const line = { t: new Date().toISOString(), level, msg };
  if (extra !== undefined) line.extra = extra instanceof Error ? { message: extra.message, stack: extra.stack } : extra;
  return JSON.stringify(line);
};
export const log = {
  info: (m, e) => console.log(fmt('info', m, e)),
  warn: (m, e) => console.warn(fmt('warn', m, e)),
  error: (m, e) => console.error(fmt('error', m, e)),
};
