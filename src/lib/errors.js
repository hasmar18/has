export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
export const badRequest = (msg, code = 'bad_request', extra) => new HttpError(400, code, msg, extra);
export const unauthorized = (msg = 'Je potřeba se přihlásit.') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'K této akci nemáte oprávnění.') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'Nenalezeno.') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, code = 'conflict', extra) => new HttpError(409, code, msg, extra);
export const tooMany = (msg = 'Příliš mnoho požadavků, zkuste to prosím za chvíli.') => new HttpError(429, 'rate_limited', msg);
