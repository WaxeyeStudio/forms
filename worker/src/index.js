/**
 * Waxeye Forms — Cloudflare Worker
 *
 * Public form-submission endpoint for client websites:
 *
 *   POST https://forms.waxeye.co.nz/f/{client-slug}
 *
 * Client slugs are configured in `clients.json` and synced to the
 * FORMS_CONFIG KV namespace by deploy.sh. Unknown slugs are rejected with 404,
 * so a client must be onboarded before their forms work.
 *
 * Each accepted submission is written to EspoCRM through its REST API (the API
 * key is held as a Worker secret). Every other request on the hostname — the
 * EspoCRM UI and EspoCRM's own /api/v1 — passes straight through to the origin
 * (Laravel Forge → Docker).
 *
 * Configuration:
 *
 *   FORMS_CONFIG (KV)     client config, key `client:{slug}`:
 *                         {
 *                           "enabled": true,                        // default true
 *                           "origins": ["https://client.co.nz"],    // optional; falls back to ALLOWED_ORIGINS
 *                           "entity": "Lead",                       // optional; falls back to ESPOCRM_ENTITY
 *                           "source": "Web Site"                    // optional; falls back to ESPOCRM_SOURCE
 *                         }
 *   RATE_LIMITER          per (client, IP) limiter, 10 requests / 60 s
 *   ESPOCRM_API_URL       e.g. https://forms.waxeye.co.nz/api/v1
 *   ESPOCRM_ENTITY        fallback entity, default "Lead"
 *   ESPOCRM_SOURCE        fallback source value, default "Web Site"
 *   ALLOWED_ORIGINS       fallback origin allowlist for clients without
 *                         `origins`; comma-separated or "*" (default "*")
 *   ESPOCRM_CLIENT_FIELD  optional custom field receiving the client slug
 *   ESPOCRM_API_KEY       (secret) EspoCRM API user key
 *   WORKER_API_SECRET     (secret) optional shared secret for server callers
 *   REQUIRE_SECRET        "true" requires X-Worker-Secret on every request
 */

const CLIENT_PATH = /^\/f\/([A-Za-z0-9][A-Za-z0-9_-]{0,63})\/?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 5000;
const MAX_EXTRA_CHARS = 2000;
const CONFIG_CACHE_TTL = 60;

const HONEYPOT_FIELDS = ['_gotcha', 'company_website', 'address2', 'honeypot'];

/** Fields that are mapped onto EspoCRM fields or otherwise consumed. */
const MAPPED_FIELDS = new Set([
  'name', 'full_name', 'fullName',
  'first_name', 'firstName', 'last_name', 'lastName',
  'email', 'email_address', 'emailAddress',
  'phone', 'phone_number', 'phoneNumber',
  'message', 'body',
  'company', 'website', 'subject',
  'form', 'form_name',
  'client', 'submit', 'csrf_token', '_token',
  ...HONEYPOT_FIELDS,
]);

/**
 * @typedef {Object} Env
 * @property {string} [ESPOCRM_API_URL]
 * @property {string} [ESPOCRM_ENTITY]
 * @property {string} [ESPOCRM_SOURCE]
 * @property {string} [ESPOCRM_CLIENT_FIELD]
 * @property {string} [ALLOWED_ORIGINS]
 * @property {string} [WORKER_API_SECRET]
 * @property {string} [REQUIRE_SECRET]
 * @property {KVNamespace} [FORMS_CONFIG]
 * @property {{ limit: (options: { key: string }) => Promise<{ success: boolean }> }} [RATE_LIMITER]
 */

/**
 * @typedef {Object} ClientConfig
 * @property {boolean} enabled
 * @property {string[]} origins   Normalised origins; empty means "use fallback"
 * @property {string} entity      Empty means "use fallback"
 * @property {string} source      Empty means "use fallback"
 */

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} _ctx
   * @returns {Promise<Response>}
   */
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const match = url.pathname.match(CLIENT_PATH);

    if (!match) {
      return json(404, { ok: false, error: 'not_found' });
    }

    if (request.method !== 'GET' && request.method !== 'POST' && request.method !== 'OPTIONS') {
      return json(405, { ok: false, error: 'method_not_allowed' }, { Allow: 'GET, POST, OPTIONS' });
    }

    const client = match[1];

    const loaded = await loadClient(env, client);
    if (loaded.error) return loaded.error;
    const cfg = loaded.cfg;
    const origins = resolveOrigins(env, cfg);
    const cors = corsHeaders(origins, request);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === 'GET') {
      return json(200, { ok: true, service: 'waxeye-forms', client, enabled: cfg.enabled }, cors);
    }

    if (!cfg.enabled) {
      console.log(`[${client}] rejected: client disabled`);
      return json(403, { ok: false, error: 'client_disabled' }, cors);
    }

    if (!originAllowed(origins, request)) {
      return json(403, { ok: false, error: 'origin_not_allowed' }, cors);
    }

    const providedSecret = request.headers.get('X-Worker-Secret') || '';
    const secret = env.WORKER_API_SECRET || '';
    const secretOk = Boolean(secret && providedSecret && timingSafeEqual(providedSecret, secret));

    if (secret && providedSecret && !secretOk) {
      return json(401, { ok: false, error: 'invalid_secret' }, cors);
    }

    if (isTrue(env.REQUIRE_SECRET) && !secretOk) {
      return json(401, { ok: false, error: 'unauthorized' }, cors);
    }

    // Trusted callers (correct shared secret) skip the public rate limit.
    if (!secretOk && env.RATE_LIMITER) {
      const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
      try {
        const { success } = await env.RATE_LIMITER.limit({ key: `${client}:${ip}` });
        if (!success) {
          console.log(`[${client}] rate limited ${ip}`);
          return json(429, { ok: false, error: 'rate_limited' }, cors);
        }
      } catch (error) {
        console.error('rate limiter failed:', error instanceof Error ? error.message : error);
      }
    }

    const declaredLength = Number(request.headers.get('Content-Length') || 0);
    if (declaredLength > MAX_BODY_BYTES) {
      return json(413, { ok: false, error: 'payload_too_large' }, cors);
    }

    /** @type {Record<string, unknown>} */
    let data;
    try {
      data = await parseSubmission(request);
    } catch {
      return json(400, { ok: false, error: 'invalid_body' }, cors);
    }

    for (const field of HONEYPOT_FIELDS) {
      if (str(data[field])) {
        console.log(`[${client}] honeypot field "${field}" filled; dropping submission`);
        return json(200, { ok: true }, cors);
      }
    }

    const email = str(data.email ?? data.email_address ?? data.emailAddress);
    if (email && !EMAIL_RE.test(email)) {
      return json(422, { ok: false, error: 'invalid_email' }, cors);
    }

    const hasContent = [
      'name', 'full_name', 'fullName',
      'first_name', 'firstName', 'last_name', 'lastName',
      'email', 'email_address', 'emailAddress',
      'phone', 'phone_number', 'phoneNumber',
      'message', 'body',
    ].some((key) => str(data[key]));

    if (!hasContent) {
      return json(422, { ok: false, error: 'empty_submission' }, cors);
    }

    const apiBase = str(env.ESPOCRM_API_URL).replace(/\/+$/, '');
    const apiKey = str(env.ESPOCRM_API_KEY);

    if (!apiBase || !apiKey) {
      console.error('ESPOCRM_API_URL or ESPOCRM_API_KEY is not configured');
      return json(503, { ok: false, error: 'service_not_configured' }, cors);
    }

    const entity = cfg.entity || str(env.ESPOCRM_ENTITY) || 'Lead';
    const payload = mapToEspo(env, cfg, client, data, request);

    /** @type {Response} */
    let upstream;
    try {
      upstream = await fetch(`${apiBase}/${encodeURIComponent(entity)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      console.error('EspoCRM request failed:', error instanceof Error ? error.message : error);
      return json(502, { ok: false, error: 'upstream_unreachable' }, cors);
    }

    const upstreamBody = await upstream.text();

    if (!upstream.ok) {
      console.error(`EspoCRM rejected submission (${upstream.status}): ${upstreamBody.slice(0, 500)}`);
      return json(502, { ok: false, error: 'upstream_rejected' }, cors);
    }

    let recordId = '';
    try {
      recordId = String(JSON.parse(upstreamBody).id || '');
    } catch {
      // EspoCRM responded 2xx with a non-JSON body; not fatal.
    }

    console.log(`[${client}] submission accepted${recordId ? ` (${entity} ${recordId})` : ''}`);
    return json(200, { ok: true, id: recordId }, cors);
  },
};

/**
 * Load and normalise a client's config from KV.
 *
 * @param {Env} env
 * @param {string} client
 * @returns {Promise<{ cfg: ClientConfig } | { error: Response }>}
 */
async function loadClient(env, client) {
  if (!env.FORMS_CONFIG) {
    console.error('FORMS_CONFIG KV binding is missing; refusing to process submissions');
    return { error: json(503, { ok: false, error: 'service_not_configured' }) };
  }

  /** @type {unknown} */
  let value;
  try {
    value = await env.FORMS_CONFIG.get(`client:${client}`, { type: 'json', cacheTtl: CONFIG_CACHE_TTL });
  } catch (error) {
    console.error(`KV read failed for client "${client}":`, error instanceof Error ? error.message : error);
    return { error: json(503, { ok: false, error: 'service_unavailable' }) };
  }

  if (value === null || value === undefined) {
    return { error: json(404, { ok: false, error: 'unknown_client' }) };
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    console.error(`Invalid config for client "${client}" (expected a JSON object)`);
    return { error: json(503, { ok: false, error: 'service_unavailable' }) };
  }

  return { cfg: normalizeConfig(/** @type {Record<string, unknown>} */ (value)) };
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {ClientConfig}
 */
function normalizeConfig(raw) {
  /** @type {string[]} */
  let origins = [];
  if (Array.isArray(raw.origins)) {
    origins = raw.origins
      .filter((item) => typeof item === 'string' && item.trim())
      .map((item) => normalizeOrigin(item));
  }

  return {
    enabled: raw.enabled !== false,
    origins,
    entity: str(raw.entity),
    source: str(raw.source),
  };
}

/**
 * The origins to enforce for this client: their own allowlist, or the global
 * fallback (which defaults to "*").
 *
 * @param {Env} env
 * @param {ClientConfig} cfg
 * @returns {string[]}
 */
function resolveOrigins(env, cfg) {
  if (cfg.origins.length > 0) return cfg.origins;
  const fallback = parseList(env.ALLOWED_ORIGINS).map(normalizeOrigin);
  return fallback.length > 0 ? fallback : ['*'];
}

/**
 * Map a submission onto an EspoCRM payload.
 *
 * @param {Env} env
 * @param {ClientConfig} cfg
 * @param {string} client
 * @param {Record<string, unknown>} data
 * @param {Request} request
 * @returns {Record<string, string>}
 */
function mapToEspo(env, cfg, client, data, request) {
  const payload = { ...nameFields(data) };

  const email = str(data.email ?? data.email_address ?? data.emailAddress);
  if (email) payload.emailAddress = email;

  const phone = str(data.phone ?? data.phone_number ?? data.phoneNumber);
  if (phone) payload.phoneNumber = phone;

  const website = str(data.website);
  if (website) payload.website = website;

  payload.description = buildDescription(client, data, request);

  const source = cfg.source || str(env.ESPOCRM_SOURCE) || 'Web Site';
  if (source) payload.source = source;

  const clientField = str(env.ESPOCRM_CLIENT_FIELD);
  if (clientField) payload[clientField] = client;

  return payload;
}

/**
 * Split the submission into EspoCRM firstName/lastName. EspoCRM requires a
 * non-empty lastName, so everything falls back to that.
 *
 * @param {Record<string, unknown>} data
 * @returns {{ firstName?: string, lastName: string }}
 */
function nameFields(data) {
  const first = str(data.first_name ?? data.firstName);
  const last = str(data.last_name ?? data.lastName);
  if (last) return first ? { firstName: first, lastName: last } : { lastName: last };
  if (first) return { lastName: first };
  const name = str(data.name) || str(data.full_name ?? data.fullName);
  return { lastName: name || 'Website submission' };
}

/**
 * Build the CRM description: the sender's message, followed by provenance and
 * any fields that don't map onto standard EspoCRM fields.
 *
 * @param {string} client
 * @param {Record<string, unknown>} data
 * @param {Request} request
 * @returns {string}
 */
function buildDescription(client, data, request) {
  const parts = [];

  const message = str(data.message ?? data.body);
  if (message) parts.push(message.slice(0, MAX_MESSAGE_CHARS));

  const lines = ['---', `Client: ${client}`];

  const form = str(data.form ?? data.form_name);
  if (form) lines.push(`Form: ${form}`);

  const company = str(data.company);
  if (company) lines.push(`Company (form field): ${company}`);

  const subject = str(data.subject);
  if (subject) lines.push(`Subject: ${subject}`);

  const referer = request.headers.get('Referer');
  if (referer) lines.push(`Page: ${referer.slice(0, 300)}`);

  const ip = request.headers.get('CF-Connecting-IP');
  if (ip) {
    const country = request.cf && request.cf.country ? ` (${request.cf.country})` : '';
    lines.push(`IP: ${ip}${country}`);
  }

  lines.push(`Received: ${new Date().toISOString()}`);

  const extras = {};
  for (const [key, value] of Object.entries(data)) {
    if (MAPPED_FIELDS.has(key)) continue;
    const text = str(value);
    if (text) extras[key] = text;
  }
  if (Object.keys(extras).length > 0) {
    lines.push(`Extra fields: ${JSON.stringify(extras).slice(0, MAX_EXTRA_CHARS)}`);
  }

  parts.push(lines.join('\n'));
  return parts.join('\n\n');
}

/**
 * Parse a JSON, urlencoded, or multipart form body into a flat object.
 * File uploads in multipart bodies are ignored.
 *
 * @param {Request} request
 * @returns {Promise<Record<string, unknown>>}
 */
async function parseSubmission(request) {
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();

  if (contentType.includes('application/json')) {
    const data = await request.json();
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('expected a JSON object');
    }
    return /** @type {Record<string, unknown>} */ (data);
  }

  if (contentType.includes('form')) {
    const form = await request.formData();
    /** @type {Record<string, unknown>} */
    const data = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === 'string') data[key] = value;
    }
    return data;
  }

  const text = (await request.text()).trim();
  if (!text) return {};

  if (text.startsWith('{')) {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('expected a JSON object');
    }
    return /** @type {Record<string, unknown>} */ (data);
  }

  return Object.fromEntries(new URLSearchParams(text).entries());
}

/**
 * CORS headers for the response. When the allowed list contains "*" any origin
 * is allowed; otherwise the request's Origin is echoed back when it matches.
 *
 * @param {string[]} origins
 * @param {Request} request
 * @returns {Record<string, string>}
 */
function corsHeaders(origins, request) {
  const origin = request.headers.get('Origin') || '';
  const normalized = normalizeOrigin(origin);

  /** @type {Record<string, string>} */
  const headers = {};
  let allow = '';

  if (origins.includes('*')) {
    allow = '*';
  } else if (normalized && origins.includes(normalized)) {
    allow = origin;
  }

  if (allow) {
    headers['Access-Control-Allow-Origin'] = allow;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, X-Worker-Secret';
    headers['Access-Control-Max-Age'] = '86400';
    if (allow !== '*') headers.Vary = 'Origin';
  }

  return headers;
}

/**
 * Whether the request's origin is allowed. Requests without an Origin header
 * (server-to-server, curl) are always allowed; browser enforcement and the 403
 * in the fetch handler both apply when an allowlist is configured.
 *
 * @param {string[]} origins
 * @param {Request} request
 * @returns {boolean}
 */
function originAllowed(origins, request) {
  if (origins.includes('*')) return true;
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  return origins.includes(normalizeOrigin(origin));
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeOrigin(value) {
  return String(value).trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {string | undefined} value
 * @returns {boolean}
 */
function isTrue(value) {
  return /^(1|true|yes)$/i.test(String(value || ''));
}

/**
 * Constant-time string comparison for shared secrets.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Coerce a form value to a trimmed string. Objects and arrays are dropped.
 *
 * @param {unknown} value
 * @returns {string}
 */
function str(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return '';
  return String(value).trim();
}

/**
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [headers]
 * @returns {Response}
 */
function json(status, body, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(headers || {}) },
  });
}
