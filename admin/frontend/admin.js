import { protectAdminRoute, logoutAdmin } from './Logic/accounts.js';
import { sendInvite } from './Logic/call_invite_api.js';
import { getAdminOverview, updateWorkspaceStatus } from './Logic/fetch_API.js';
import { setInviteStatus, setButtonLoading } from './Logic/ui.js';

if (!await protectAdminRoute()) throw new Error('Administrator session required.');

const inviteForm = document.getElementById('invite-form');
const emailInput = document.getElementById('client-email');
const workspaceInput = document.getElementById('workspace-name');
const inviteButton = document.getElementById('invite-btn');
const inviteStatus = document.getElementById('invite-status');
const workspaceRows = document.getElementById('workspace-rows');
const workspaceSearch = document.getElementById('workspace-search');
const workspaceFilter = document.getElementById('workspace-filter');
const workspaceCount = document.getElementById('workspace-count');
const workspaceError = document.getElementById('workspace-error');
const refreshButton = document.getElementById('refresh-workspaces');
const logoutButton = document.getElementById('admin-logout-btn');
let overview = { workspaces: [], stats: {} };

logoutButton?.addEventListener('click', logoutAdmin);
workspaceSearch.addEventListener('input', renderWorkspaces);
workspaceFilter.addEventListener('change', renderWorkspaces);
refreshButton.addEventListener('click', loadOverview);

function makeCell(content, className = '') {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    if (content instanceof Node) cell.append(content);
    else cell.textContent = content;
    return cell;
}

function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: 'numeric'
    }).format(date);
}

function statusControl(workspace) {
    const wrap = document.createElement('div');
    wrap.className = 'status-control';

    const select = document.createElement('select');
    select.setAttribute('aria-label', `Set ${workspace.name} status`);
    for (const status of ['active', 'suspended', 'banned']) {
        const option = document.createElement('option');
        option.value = status;
        option.textContent = status[0].toUpperCase() + status.slice(1);
        option.selected = workspace.status === status;
        select.append(option);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'status-save';
    button.textContent = 'Save';
    button.disabled = true;
    select.addEventListener('change', () => { button.disabled = select.value === workspace.status; });
    button.addEventListener('click', async () => {
        button.disabled = true;
        button.textContent = 'Saving…';
        try {
            await updateWorkspaceStatus(workspace.id, select.value);
            await loadOverview();
        } catch (error) {
            showWorkspaceError(error.message);
            button.disabled = false;
            button.textContent = 'Save';
        }
    });
    wrap.append(select, button);
    return wrap;
}

function renderWorkspaces() {
    const query = workspaceSearch.value.trim().toLowerCase();
    const status = workspaceFilter.value;
    const rows = overview.workspaces.filter((workspace) => {
        const members = (workspace.members || []).map((member) => member.email).join(' ');
        const searchable = `${workspace.name} ${workspace.id} ${members}`.toLowerCase();
        return (!query || searchable.includes(query)) && (status === 'all' || workspace.status === status);
    });

    workspaceRows.replaceChildren();
    workspaceCount.textContent = `${rows.length} of ${overview.workspaces.length} workspaces`;
    if (!rows.length) {
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'table-message';
        cell.textContent = overview.workspaces.length ? 'No workspaces match these filters.' : 'No client workspaces yet. Send an invitation to get started.';
        row.append(cell);
        workspaceRows.append(row);
        return;
    }

    for (const workspace of rows) {
        const row = document.createElement('tr');
        const identity = document.createElement('div');
        identity.className = 'workspace-identity';
        const name = document.createElement('strong');
        name.textContent = workspace.name || 'Unnamed workspace';
        const id = document.createElement('small');
        id.textContent = workspace.id;
        identity.append(name, id);
        row.append(makeCell(identity, 'workspace-name-cell'));

        const members = document.createElement('div');
        members.className = 'member-list';
        if (workspace.members?.length) {
            for (const member of workspace.members) {
                const item = document.createElement('span');
                item.textContent = member.email;
                members.append(item);
            }
        } else {
            members.textContent = 'No members';
        }
        row.append(makeCell(members));

        const accountCell = document.createElement('div');
        accountCell.className = 'account-list';
        if (workspace.connectedAccounts?.length) {
            for (const account of workspace.connectedAccounts) {
                const item = document.createElement('span');
                item.className = 'account-chip';
                item.textContent = `${account.platform} · ${account.igAccountId || account.id} · ${account.monitoredPostCount} posts`;
                accountCell.append(item);
            }
        } else {
            accountCell.textContent = 'Not connected';
        }
        row.append(makeCell(accountCell));
        const activity = document.createElement('div');
        activity.className = 'activity-summary';
        const flowSummary = document.createElement('strong');
        flowSummary.textContent = `${workspace.activity?.activeFlows || 0} active flows`;
        const commentSummary = document.createElement('small');
        commentSummary.textContent = `${workspace.activity?.comments || 0} comments processed`;
        activity.append(flowSummary, commentSummary);
        const failures = (workspace.activity?.failedReplies || 0) + (workspace.activity?.failedDms || 0);
        if (failures) {
            const failureSummary = document.createElement('small');
            failureSummary.className = 'activity-warning';
            failureSummary.textContent = `${failures} failed sends`;
            activity.append(failureSummary);
        }
        row.append(makeCell(activity));
        row.append(makeCell(formatDate(workspace.createdAt)));

        const badge = document.createElement('span');
        badge.className = `status-badge status-${workspace.status}`;
        badge.textContent = workspace.status;
        row.append(makeCell(badge));
        row.append(makeCell(statusControl(workspace), 'manage-cell'));
        workspaceRows.append(row);
    }
}

function showWorkspaceError(message) {
    workspaceError.hidden = !message;
    workspaceError.textContent = message || '';
}

async function loadOverview() {
    refreshButton.disabled = true;
    refreshButton.classList.add('is-loading');
    showWorkspaceError('');
    try {
        overview = await getAdminOverview();
        const stats = overview.stats || {};
        document.getElementById('stat-workspaces').textContent = stats.totalWorkspaces ?? 0;
        document.getElementById('stat-active').textContent = stats.activeWorkspaces ?? 0;
        document.getElementById('stat-accounts').textContent = stats.connectedAccounts ?? 0;
        document.getElementById('stat-comments').textContent = stats.commentsProcessed ?? 0;
        renderWorkspaces();
    } catch (error) {
        showWorkspaceError(error.message || 'Could not load workspace data.');
        workspaceCount.textContent = 'Data unavailable';
        workspaceRows.replaceChildren();
        const row = document.createElement('tr');
        const cell = document.createElement('td');
        cell.colSpan = 7;
        cell.className = 'table-message';
        cell.textContent = 'Workspace data could not be loaded. Refresh to try again.';
        row.append(cell);
        workspaceRows.append(row);
    } finally {
        refreshButton.disabled = false;
        refreshButton.classList.remove('is-loading');
    }
}

inviteForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    setButtonLoading(inviteButton, true);
    inviteStatus.style.display = 'none';
    try {
        const email = emailInput.value.trim();
        const { ok, data } = await sendInvite(email, workspaceInput.value.trim());
        if (!ok) throw new Error(data.error || 'Could not send the invitation.');
        setInviteStatus(inviteStatus, `Invitation sent to ${email}.`, true);
        inviteForm.reset();
        await loadOverview();
    } catch (error) {
        setInviteStatus(inviteStatus, error.message || 'Could not send the invitation.', false);
    } finally {
        setButtonLoading(inviteButton, false);
    }
});

await loadOverview();
