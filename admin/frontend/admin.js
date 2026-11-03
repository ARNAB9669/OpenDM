import { protectAdminRoute, logoutAdmin } from './Logic/accounts.js';
import { sendInvite } from './Logic/call_invite_api.js';
import { getAccounts, toggleBan } from './Logic/fetch_API.js';
import { setInviteStatus, setButtonLoading, updateTelemetry, renderAccountsList } from './Logic/ui.js';

// Secure the route
// protectAdminRoute();

const inviteForm = document.getElementById('invite-form');
const emailInput = document.getElementById('client-email');
const submitBtn = document.getElementById('invite-btn');
const statusDiv = document.getElementById('invite-status');
const accountsContainer = document.getElementById('accounts-container');
const logoutBtn = document.getElementById('admin-logout-btn');

async function loadDashboard() {
    const accounts = await getAccounts();

    // Calculates total workspaces directly from the array length
    const stats = {
        workspaces: accounts.length,
        metaConnections: accounts.filter(a => a.has_meta_connected).length || 0,
        commentsProcessed: 0 // Placeholder until hooked up to the comment_events table
    };

    updateTelemetry(stats);

    renderAccountsList(accountsContainer, accounts, async (id, status) => {
        const success = await toggleBan(id, status);
        if (success) {
            await loadDashboard();
        } else {
            alert('Failed to update workspace status.');
            await loadDashboard();
        }
    });
}

logoutBtn?.addEventListener('click', logoutAdmin);

inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setButtonLoading(submitBtn, true);

    const { ok, data } = await sendInvite(emailInput.value);

    if (ok) {
        setInviteStatus(statusDiv, 'Workspace created and invite sent!', true);
        emailInput.value = '';
        await loadDashboard();
    } else {
        setInviteStatus(statusDiv, data.error || 'Failed to send invite.', false);
    }

    setButtonLoading(submitBtn, false);
});

// Initialize on page load
loadDashboard();