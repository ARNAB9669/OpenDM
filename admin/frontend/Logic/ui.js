export function setInviteStatus(element, message, isSuccess) {
    element.style.display = 'block';
    element.textContent = message;
    element.style.color = isSuccess ? '#10b981' : '#ef4444';
}

export function setButtonLoading(button, isLoading) {
    button.disabled = isLoading;
    button.textContent = isLoading ? 'Sending Invite...' : 'Send Invite';
}

export function updateTelemetry(stats) {
    document.getElementById('stat-workspaces').textContent = stats.workspaces || 0;
    document.getElementById('stat-meta').textContent = stats.metaConnections || 0;
    document.getElementById('stat-comments').textContent = stats.commentsProcessed || 0;
}

export function renderAccountsList(container, accounts, onToggleBan) {
    container.innerHTML = '';

    if (accounts.length === 0) {
        container.innerHTML = '<p style="color: #a0a0a0;">No workspaces found.</p>';
        return;
    }

    accounts.forEach(acc => {
        const isBanned = acc.status === 'banned';
        const row = document.createElement('div');
        row.className = 'account-row';

        row.innerHTML = `
            <div class="account-info">
                <strong>Workspace: ${acc.id}</strong>
                <div class="details">Created: ${new Date(acc.created_at).toLocaleDateString()}</div>
                <span class="status-badge ${isBanned ? 'banned' : ''}">${acc.status || 'active'}</span>
            </div>
            <button class="${isBanned ? 'btn-unban' : 'btn-ban'}" data-id="${acc.id}" data-status="${acc.status || 'active'}">
                ${isBanned ? 'Unban' : 'Ban'}
            </button>
        `;
        container.appendChild(row);
    });

    container.querySelectorAll('button[data-id]').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const btnEl = e.target;
            const id = btnEl.getAttribute('data-id');
            const status = btnEl.getAttribute('data-status');

            btnEl.disabled = true;
            btnEl.textContent = 'Updating...';
            await onToggleBan(id, status);
        });
    });
}