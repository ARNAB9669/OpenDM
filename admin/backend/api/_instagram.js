import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000;

export function instagramRedirectUri() {
    const appUrl = process.env.APP_URL;
    if (!appUrl) throw new Error('Missing required server environment variable: APP_URL');
    return `${appUrl.replace(/\/+$/, '')}/api/instagram-callback`;
}

export function createInstagramState(workspaceId, userId) {
    const payload = Buffer.from(JSON.stringify({
        workspaceId,
        userId,
        nonce: randomBytes(24).toString('base64url'),
        expiresAt: Date.now() + STATE_TTL_MS
    })).toString('base64url');
    const signature = createHmac('sha256', requiredAppSecret()).update(payload).digest('base64url');
    const value = `${payload}.${signature}`;
    return { value, expiresAt: new Date(Date.now() + STATE_TTL_MS).toISOString() };
}

export function parseInstagramState(value) {
    if (typeof value !== 'string') return null;
    const [payload, signature, ...extra] = value.split('.');
    if (!payload || !signature || extra.length) return null;

    const expected = createHmac('sha256', requiredAppSecret()).update(payload).digest();
    let actual;
    try {
        actual = Buffer.from(signature, 'base64url');
    } catch {
        return null;
    }
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;

    try {
        const state = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!state.workspaceId || !state.userId || !state.nonce || !Number.isFinite(state.expiresAt) || state.expiresAt < Date.now()) return null;
        return state;
    } catch {
        return null;
    }
}

export function hashInstagramState(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function graphVersion() {
    return process.env.GRAPH_API_VERSION || 'v25.0';
}

export function graphUrl(path) {
    return `https://graph.facebook.com/${graphVersion()}/${path.replace(/^\/+/, '')}`;
}

export function metaLoginConfigId() {
    const value = process.env.META_LOGIN_CONFIG_ID;
    if (!value) throw new Error('Missing required server environment variable: META_LOGIN_CONFIG_ID');
    return value;
}

function requiredAppSecret() {
    const secret = process.env.META_APP_SECRET;
    if (!secret) throw new Error('Missing required server environment variable: META_APP_SECRET');
    return secret;
}
