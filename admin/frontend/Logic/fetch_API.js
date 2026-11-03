export async function getAccounts() {
    try {
        const response = await fetch('/api/accounts');
        if (!response.ok) return [];
        return await response.json();
    } catch (e) {
        console.error("Failed to fetch accounts:", e);
        return [];
    }
}

export async function toggleBan(workspaceId, currentStatus) {
    const newStatus = currentStatus === 'active' ? 'banned' : 'active';
    try {
        const response = await fetch('/api/ban', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workspaceId, status: newStatus })
        });
        return response.ok;
    } catch (e) {
        console.error("Failed to toggle ban status:", e);
        return false;
    }
}