export class ApiError extends Error { constructor(status, body) { super(body?.error || `http_${status}`); this.status = status; this.body = body; } }
export const isOnline = () => navigator.onLine;
export async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch (e) { throw new ApiError(0, { error: 'network' }); }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}
export const get = p => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const patch = (p, b) => api('PATCH', p, b);
export const put = (p, b) => api('PUT', p, b);
export const del = p => api('DELETE', p, {});
