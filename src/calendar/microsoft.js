import { config } from '../config.js';
import { dayStartUtc, localDateStr, addMinutes } from '../lib/time.js';
import { ProviderAuthError, httpJson } from './providers.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SCOPES = 'offline_access Calendars.ReadWrite User.Read';
const authority = () => `https://login.microsoftonline.com/${config.microsoft.tenant}/oauth2/v2.0`;

async function api(token, path, opts = {}) {
  const url = path.startsWith('http') ? path : `${GRAPH}${path}`;
  const r = await httpJson(url, { ...opts, headers: { authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 401) throw new ProviderAuthError('Microsoft: přístup byl odmítnut (401).');
  return r;
}
const fail = (what, r) => {
  const e = new Error(`Microsoft ${what}: HTTP ${r.status} ${r.data?.error?.message || ''}`.trim());
  e.status = r.status;
  return e;
};

// Graph vrací dateTime bez přípony – při Prefer: outlook.timezone="UTC" jde o UTC.
const parseGraphUtc = (s) => new Date(/Z$|[+-]\d{2}:\d{2}$/.test(s) ? s : `${s.replace(/(\.\d{3})\d+$/, '$1')}Z`);

export const microsoft = {
  name: 'microsoft',
  label: 'Outlook / Microsoft 365 Kalendář',
  note: 'Obousměrná synchronizace přes Microsoft Graph (OAuth).',
  isConfigured: () => Boolean(config.microsoft.clientId && config.microsoft.clientSecret),

  authUrl({ state, redirectUri }) {
    const p = new URLSearchParams({
      client_id: config.microsoft.clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
      scope: SCOPES, state, prompt: 'select_account',
    });
    return `${authority()}/authorize?${p}`;
  },

  async exchangeCode({ code, redirectUri }) {
    const r = await httpJson(`${authority()}/token`, {
      method: 'POST', form: { client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, code, redirect_uri: redirectUri, grant_type: 'authorization_code', scope: SCOPES },
    });
    if (!r.ok || !r.data.access_token) throw new Error(`Microsoft: výměna kódu selhala (${r.status} ${r.data?.error_description?.slice(0, 120) || ''})`);
    return { refreshToken: r.data.refresh_token, accessToken: r.data.access_token, expiresIn: r.data.expires_in };
  },

  async refreshAccessToken(refreshToken) {
    const r = await httpJson(`${authority()}/token`, {
      method: 'POST', form: { client_id: config.microsoft.clientId, client_secret: config.microsoft.clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token', scope: SCOPES },
    });
    if (r.status === 400 || r.status === 401) {
      if (['invalid_grant', 'interaction_required', 'invalid_client'].includes(r.data?.error)) throw new ProviderAuthError(`Microsoft: autorizace vypršela nebo byla zrušena (${r.data.error}).`);
    }
    if (!r.ok) throw new Error(`Microsoft: obnovení tokenu selhalo (${r.status})`);
    return { accessToken: r.data.access_token, expiresIn: r.data.expires_in, refreshToken: r.data.refresh_token };
  },

  async getAccountEmail(token) {
    const r = await api(token, '/me?$select=mail,userPrincipalName');
    if (!r.ok) throw fail('/me', r);
    return r.data.mail || r.data.userPrincipalName || 'microsoft-account';
  },

  async listCalendars(token) {
    const r = await api(token, '/me/calendars?$select=id,name,canEdit,isDefaultCalendar&$top=100');
    if (!r.ok) throw fail('calendars', r);
    return (r.data.value || []).map((c) => ({ id: c.id, name: c.name, primary: Boolean(c.isDefaultCalendar), canWrite: Boolean(c.canEdit) }));
  },

  async listEvents(token, { calendarId, from, to, tz }) {
    const out = [];
    let url = `/me/calendars/${encodeURIComponent(calendarId)}/calendarView?${new URLSearchParams({
      startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '100',
      $select: 'id,start,end,isAllDay,isCancelled,showAs,categories,responseStatus',
    })}`;
    while (url) {
      const r = await api(token, url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
      if (!r.ok) throw fail('calendarView', r);
      for (const e of r.data.value || []) {
        let start = parseGraphUtc(e.start.dateTime);
        let end = parseGraphUtc(e.end.dateTime);
        if (e.isAllDay) { // celodenní událost → celé místní dny studia
          start = dayStartUtc(localDateStr(addMinutes(start, 12 * 60), tz), tz);
          end = dayStartUtc(localDateStr(addMinutes(end, 12 * 60), tz), tz);
        }
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        out.push({
          id: e.id, start, end, allDay: Boolean(e.isAllDay), etag: null,
          cancelled: Boolean(e.isCancelled) || e.responseStatus?.response === 'declined',
          transparent: e.showAs === 'free' || e.showAs === 'workingElsewhere',
          ours: (e.categories || []).includes('HASNAILS'),
        });
      }
      url = r.data['@odata.nextLink'] || '';
    }
    return out;
  },

  async upsertEvent(token, { calendarId, bookingId, existingEventId, summary, description, start, end }) {
    const iso = (d) => ({ dateTime: d.toISOString().replace('Z', ''), timeZone: 'UTC' });
    const body = { subject: summary, body: { contentType: 'text', content: description }, start: iso(start), end: iso(end), categories: ['HASNAILS'], showAs: 'busy' };
    if (existingEventId) {
      const r = await api(token, `/me/events/${encodeURIComponent(existingEventId)}`, { method: 'PATCH', body });
      if (r.ok) return { eventId: r.data.id, etag: null };
      if (r.status !== 404) throw fail('event.patch', r);
    }
    const r = await api(token, `/me/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', body: { ...body, transactionId: bookingId } });
    if (!r.ok) throw fail('event.create', r);
    return { eventId: r.data.id, etag: null };
  },

  async deleteEvent(token, { eventId }) {
    const r = await api(token, `/me/events/${encodeURIComponent(eventId)}`, { method: 'DELETE' });
    if (r.ok || r.status === 404 || r.status === 410) return;
    throw fail('event.delete', r);
  },

  async watch(token, { calendarId, secret, address }) {
    const expires = new Date(Date.now() + 4200 * 60_000); // max. cca 4230 min pro události kalendáře
    const r = await api(token, '/subscriptions', {
      method: 'POST', body: { changeType: 'created,updated,deleted', notificationUrl: address, resource: `/me/calendars/${calendarId}/events`, expirationDateTime: expires.toISOString(), clientState: secret },
    });
    if (!r.ok) throw fail('subscriptions', r);
    return { watchId: r.data.id, resourceId: null, expiresAt: new Date(r.data.expirationDateTime) };
  },

  async stopWatch(token, { watchId }) {
    await api(token, `/subscriptions/${encodeURIComponent(watchId)}`, { method: 'DELETE' });
  },
};
