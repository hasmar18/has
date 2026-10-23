// Registr poskytovatelů kalendáře. Každý poskytovatel implementuje stejné rozhraní (viz google.js).
export class ProviderAuthError extends Error {
  constructor(message) { super(message); this.name = 'ProviderAuthError'; }
}

const registry = new Map();
export const registerProvider = (impl) => registry.set(impl.name, impl);
export const getProvider = (name) => {
  const p = registry.get(name);
  if (!p) throw new Error(`Neznámý poskytovatel kalendáře: ${name}`);
  return p;
};
export const listProviders = () => [...registry.values()].filter((p) => !p.hidden).map((p) => ({
  name: p.name, label: p.label, configured: p.isConfigured(), supports_push: Boolean(p.watch),
  note: p.note || '',
}));

// Společný HTTP pomocník s časovým limitem
export async function httpJson(url, { method = 'GET', headers = {}, body, form, timeoutMs = 20_000 } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeoutMs) };
  if (form) { init.body = new URLSearchParams(form); init.headers['content-type'] = 'application/x-www-form-urlencoded'; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { status: res.status, ok: res.ok, data };
}
