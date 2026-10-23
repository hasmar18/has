import { config } from '../config.js';
import { dayStartUtc } from '../lib/time.js';
import { ProviderAuthError, httpJson } from './providers.js';

const API = 'https://www.googleapis.com/calendar/v3';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const eventIdFor = (bookingId) => `hn${bookingId.replace(/-/g, '')}`; // povolené znaky: a-v, 0-9

async function api(token, path, opts = {}) {
  const r = await httpJson(`${API}${path}`, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 401) throw new ProviderAuthError('Google: přístup byl odmítnut (401).');
  return r;
}
const fail = (what, r) => {
  const e = new Error(`Google ${what}: HTTP ${r.status} ${r.data?.error?.message || ''}`.trim());
  e.status = r.status;
  return e;
};

export const google = {
  name: 'google',
  label: 'Google Kalendář',
  note: 'Obousměrná synchronizace přes Google Calendar API (OAuth).',
  isConfigured: () => Boolean(config.google.clientId && config.google.clientSecret),

  authUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.google.clientId, redirect_uri: redirectUri, response_type: 'code', scope: SCOPES,
      access_type: 'offline', prompt: 'consent', state, include_granted_scopes: 'true',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  },

  async exchangeCode({ code, redirectUri }) {
    const r = await httpJson('https://oauth2.googleapis.com/token', {
      method: 'POST', form: { code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' },
    });
    if (!r.ok || !r.data.access_token) throw new Error(`Google: výměna kódu selhala (${r.status} ${r.data?.error_description || r.data?.error || ''})`);
    if (!r.data.refresh_token) throw new Error('Google nevydal obnovovací token. Odeberte aplikaci v nastavení Google účtu a připojte ji znovu.');
    return { refreshToken: r.data.refresh_token, accessToken: r.data.access_token, expiresIn: r.data.expires_in };
  },

  async refreshAccessToken(refreshToken) {
    const r = await httpJson('https://oauth2.googleapis.com/token', {
      method: 'POST', form: { refresh_token: refreshToken, client_id: config.google.clientId, client_secret: config.google.clientSecret, grant_type: 'refresh_token' },
    });
    if (r.status === 400 || r.status === 401) {
      if (r.data?.error === 'invalid_grant' || r.data?.error === 'invalid_client' || r.data?.error === 'unauthorized_client') {
        throw new ProviderAuthError(`Google: autorizace vypršela nebo byla zrušena (${r.data.error}).`);
      }
    }
    if (!r.ok) throw new Error(`Google: obnovení tokenu selhalo (${r.status})`);
    return { accessToken: r.data.access_token, expiresIn: r.data.expires_in };
  },

  async listCalendars(token) {
    const r = await api(token, '/users/me/calendarList?minAccessRole=reader&maxResults=250&fields=items(id,summary,primary,accessRole)');
    if (!r.ok) throw fail('calendarList', r);
    return (r.data.items || []).map((c) => ({
      id: c.id, name: c.summary || c.id, primary: Boolean(c.primary), canWrite: ['owner', 'writer'].includes(c.accessRole),
    }));
  },

  async getAccountEmail(token) {
    const cals = await this.listCalendars(token);
    return (cals.find((c) => c.primary) || cals[0])?.id || 'google-account';
  },

  async listEvents(token, { calendarId, from, to, tz }) {
    const out = [];
    let pageToken = '';
    do {
      const q = new URLSearchParams({
        timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', showDeleted: 'false', maxResults: '250',
        fields: 'nextPageToken,items(id,status,start,end,transparency,etag,extendedProperties/private,attendees(self,responseStatus))',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const r = await api(token, `/calendars/${encodeURIComponent(calendarId)}/events?${q}`);
      if (!r.ok) throw fail('events.list', r);
      for (const e of r.data.items || []) {
        const allDay = Boolean(e.start?.date);
        const start = allDay ? dayStartUtc(e.start.date, tz) : new Date(e.start?.dateTime);
        const end = allDay ? dayStartUtc(e.end.date, tz) : new Date(e.end?.dateTime);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        const self = (e.attendees || []).find((a) => a.self);
        out.push({
          id: e.id, start, end, allDay, etag: e.etag || null,
          cancelled: e.status === 'cancelled' || self?.responseStatus === 'declined',
          transparent: e.transparency === 'transparent',
          ours: Boolean(e.extendedProperties?.private?.hasnails_booking_id),
        });
      }
      pageToken = r.data.nextPageToken || '';
    } while (pageToken);
    return out;
  },

  async upsertEvent(token, { calendarId, bookingId, summary, description, start, end }) {
    const id = eventIdFor(bookingId);
    const body = {
      summary, description, status: 'confirmed', transparency: 'opaque',
      start: { dateTime: start.toISOString() }, end: { dateTime: end.toISOString() },
      extendedProperties: { private: { hasnails_booking_id: bookingId } },
    };
    const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
    let r = await api(token, `${base}?sendUpdates=none`, { method: 'POST', body: { id, ...body } });
    if (r.status === 409) r = await api(token, `${base}/${id}?sendUpdates=none`, { method: 'PATCH', body }); // už existuje → aktualizace (idempotence)
    if (!r.ok) throw fail('events.insert/patch', r);
    return { eventId: r.data.id, etag: r.data.etag || null };
  },

  async deleteEvent(token, { calendarId, eventId }) {
    const r = await api(token, `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, { method: 'DELETE' });
    if (r.ok || r.status === 404 || r.status === 410) return;
    throw fail('events.delete', r);
  },

  async watch(token, { calendarId, channelId, secret, address, ttlSeconds = 6 * 24 * 3600 }) {
    const r = await api(token, `/calendars/${encodeURIComponent(calendarId)}/events/watch`, {
      method: 'POST', body: { id: channelId, type: 'web_hook', address, token: secret, params: { ttl: String(ttlSeconds) } },
    });
    if (!r.ok) throw fail('events.watch', r);
    return { watchId: r.data.id, resourceId: r.data.resourceId, expiresAt: new Date(Number(r.data.expiration)) };
  },

  async stopWatch(token, { watchId, resourceId }) {
    await api(token, '/channels/stop', { method: 'POST', body: { id: watchId, resourceId } });
  },
};
