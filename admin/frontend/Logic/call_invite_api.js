import { getAccessToken } from './accounts.js';

export async function sendInvite(email, workspaceName) {
    try {
        const token = await getAccessToken();
        const response = await fetch('/api/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ email, workspaceName })
        });
        const result = await response.json();
        return { ok: response.ok, data: result };
    } catch (error) {
        return { ok: false, data: { error: 'Network error communicating with backend.' } };
    }
}
