// backend/auth/verify_meta_signature.js
// Verifies that a webhook request genuinely came from Meta, using the
// X-Hub-Signature-256 header and your app secret.
// Import this into cw_web_hook.js.

export async function verifyMetaSignature(rawBody, signatureHeader, appSecret) {
    if (!signatureHeader || !appSecret || typeof rawBody !== 'string') return false;

    const expected = signatureHeader.startsWith('sha256=') ? signatureHeader.slice(7) : signatureHeader;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(appSecret);
    const key = await crypto.subtle.importKey(
        'raw',
        keyData,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
    const computed = Array.from(new Uint8Array(signatureBuffer))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

    // constant-time compare
    if (computed.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < computed.length; i++) {
        diff |= computed.charCodeAt(i) ^ expected.charCodeAt(i);
    }
    return diff === 0;
}