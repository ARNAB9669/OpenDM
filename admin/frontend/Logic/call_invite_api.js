export async function sendInvite(email) {
    try {
        const response = await fetch('/api/invite', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email })
        });
        const result = await response.json();
        return { ok: response.ok, data: result };
    } catch (error) {
        return { ok: false, data: { error: 'Network error communicating with backend.' } };
    }
}