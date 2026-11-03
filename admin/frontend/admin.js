import { protectAdminRoute, logoutAdmin } from './Logic/accounts.js';
import { sendInvite } from './Logic/call_invite_api.js';
import { setInviteStatus, setButtonLoading } from './Logic/ui.js';

if (!await protectAdminRoute()) {
    throw new Error('Administrator session required.');
}

const inviteForm = document.getElementById('invite-form');
const emailInput = document.getElementById('client-email');
const workspaceInput = document.getElementById('workspace-name');
const submitBtn = document.getElementById('invite-btn');
const statusDiv = document.getElementById('invite-status');
const logoutBtn = document.getElementById('admin-logout-btn');

logoutBtn?.addEventListener('click', logoutAdmin);

inviteForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    setButtonLoading(submitBtn, true);

    const { ok, data } = await sendInvite(emailInput.value, workspaceInput.value);

    if (ok) {
        setInviteStatus(statusDiv, 'Workspace created and invite sent!', true);
        emailInput.value = '';
        workspaceInput.value = '';
    } else {
        setInviteStatus(statusDiv, data.error || 'Failed to send invite.', false);
    }

    setButtonLoading(submitBtn, false);
});
