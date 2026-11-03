import { getAccessToken } from './accounts.js';

async function adminRequest(path, options = {}) {
    const token = await getAccessToken();
    const response = await fetch(path, {
        ...options,
        headers: {
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            Authorization: `Bearer ${token}`,
            ...options.headers
        }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
}

export function getAdminOverview() {
    return adminRequest('/api/accounts');
}

export function updateWorkspaceStatus(workspaceId, status) {
    return adminRequest('/api/workspace-status', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, status })
    });
}
