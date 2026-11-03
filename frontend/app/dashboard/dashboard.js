const config = window.OPENDM_CONFIG;
const message = document.getElementById('welcome-message');
const logoutButton = document.getElementById('logout-btn');
const notice = document.getElementById('dashboard-notice');
const connectButton = document.getElementById('connect-instagram');
const accountSummary = document.getElementById('account-summary');
const mediaGrid = document.getElementById('media-grid');
const flowEditor = document.getElementById('flow-editor');
const flowForm = document.getElementById('flow-form');
const selectedMediaLabel = document.getElementById('selected-media-label');
const flowStatusButton = document.getElementById('refresh-flow-status');
let supabaseClient;
let session;
let selectedMediaId = '';
let mediaItems = [];

function showNotice(text, kind = 'info') {
    notice.textContent = text;
    notice.dataset.kind = kind;
    notice.hidden = !text;
}

async function api(path, options = {}) {
    const { data: authData, error } = await supabaseClient.auth.getSession();
    if (error) throw error;
    session = authData.session;
    if (!session) {
        window.location.replace('/auth.html');
        throw new Error('Your sign-in expired. Request a fresh sign-in link.');
    }
    const response = await fetch(path, {
        ...options,
        headers: {
            Authorization: `Bearer ${session.access_token}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {}),
            ...options.headers
        }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `Request failed (${response.status}).`);
    return payload;
}

function addText(parent, tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
}

function flowValues(flow) {
    document.getElementById('keyword-filter').value = flow?.keyword_filter || '';
    document.getElementById('reply-template').value = flow?.reply_template || '';
    document.getElementById('dm-template').value = flow?.dm_template || '';
    document.getElementById('dm-link').value = flow?.dm_link || '';
    document.getElementById('flow-active').checked = Boolean(flow?.is_active);
}

async function selectMedia(item) {
    selectedMediaId = item.id;
    showNotice('Loading the post settings…');
    try {
        const result = await api('/api/instagram-flow', {
            method: 'POST',
            body: JSON.stringify({ action: 'select', mediaId: item.id })
        });
        flowValues(result.flow);
        selectedMediaLabel.textContent = item.caption || `Instagram post ${item.id}`;
        flowEditor.hidden = false;
        showNotice('Post selected. Configure the reply and DM, then save.');
        flowEditor.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
        showNotice(error.message, 'error');
    }
}

async function refreshStatus(flowId, target) {
    try {
        const result = await api(`/api/instagram-flow-status?flowId=${encodeURIComponent(flowId)}`);
        target.textContent = `${result.summary} ${result.isActive ? 'Automation active.' : 'Automation paused.'}`;
        target.dataset.kind = result.failed ? 'warning' : 'success';
    } catch (error) {
        target.textContent = error.message;
        target.dataset.kind = 'error';
    }
}

function renderMedia(items) {
    mediaGrid.replaceChildren();
    const flows = [];
    if (!items.length) {
        addText(mediaGrid, 'p', 'empty-state', 'No recent posts were returned for this account.');
        return;
    }

    for (const item of items) {
        const card = document.createElement('article');
        card.className = 'media-card';
        const choose = document.createElement('button');
        choose.type = 'button';
        choose.className = 'media-choice';
        choose.setAttribute('aria-label', `Configure automation for ${item.caption || 'Instagram post'}`);
        if (item.imageUrl) {
            const image = document.createElement('img');
            image.src = item.imageUrl;
            image.alt = item.caption || 'Instagram post';
            image.loading = 'lazy';
            choose.append(image);
        } else {
            addText(choose, 'span', 'media-placeholder', item.mediaType || 'Post');
        }
        addText(choose, 'span', 'media-caption', item.caption || 'No caption');
        choose.addEventListener('click', () => selectMedia(item));
        card.append(choose);

        if (item.configured?.flow) {
            const flow = item.configured.flow;
            addText(card, 'p', 'flow-state', flow.is_active ? 'Automation active' : 'Automation paused');
            const status = addText(card, 'p', 'flow-status', 'Loading activity…');
            status.dataset.flowId = flow.id;
            card.append(status);
            flows.push({ id: flow.id, target: status });
        }
        if (item.permalink) {
            const link = document.createElement('a');
            link.href = item.permalink;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open on Instagram';
            card.append(link);
        }
        mediaGrid.append(card);
    }
    flows.forEach(({ id, target }) => refreshStatus(id, target));
}

async function loadInstagram() {
    const result = await api('/api/instagram-media');
    if (!result.connected) {
        connectButton.hidden = false;
        accountSummary.hidden = true;
        mediaGrid.replaceChildren();
        flowEditor.hidden = true;
        return;
    }
    connectButton.hidden = true;
    accountSummary.hidden = false;
    const expiry = result.account.expiresAt ? `expires ${new Date(result.account.expiresAt).toLocaleString()}` : 'no scheduled token expiry';
    accountSummary.textContent = `Connected as @${result.account.username}, ${expiry}.`;
    mediaItems = result.media;
    renderMedia(mediaItems);
}

async function initializeDashboard() {
    if (!config || !config.supabaseUrl || !config.supabaseAnonKey) {
        message.textContent = 'Open DM is not configured yet.';
        return;
    }
    try {
        supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
        const { data, error } = await supabaseClient.auth.getSession();
        if (error) throw error;
        session = data.session;
        if (!session) {
            window.location.replace('/auth.html');
            return;
        }
        logoutButton.addEventListener('click', async () => {
            await supabaseClient.auth.signOut();
            window.location.replace('/auth.html');
        });

        const workspace = await api('/api/client-session');
        message.textContent = `Signed in as ${session.user.email}. Workspace: ${workspace.workspaceName}.`;

        const callback = new URLSearchParams(window.location.search);
        if (callback.get('instagram') === 'connected') showNotice('Instagram connected. Choose a recent post to set up an automation.', 'success');
        else if (callback.get('instagram') === 'connected-warning') showNotice('Instagram connected, but account webhook subscription did not finish. Check Meta webhook setup and reconnect if needed.', 'warning');
        else if (callback.get('instagram') === 'error') showNotice(callback.get('reason') || 'Instagram connection failed.', 'error');
        if (callback.has('instagram')) history.replaceState({}, '', window.location.pathname);

        await loadInstagram();
    } catch (error) {
        console.error('Could not initialize the client dashboard:', error);
        showNotice(error.message || 'Could not load the workspace. Refresh or contact the administrator.', 'error');
        if (message) message.textContent = 'Workspace setup could not be loaded.';
    }
}

connectButton.addEventListener('click', async () => {
    connectButton.disabled = true;
    connectButton.textContent = 'Starting Instagram connection…';
    try {
        const { authorizeUrl } = await api('/api/instagram-connect', { method: 'POST' });
        window.location.assign(authorizeUrl);
    } catch (error) {
        showNotice(error.message, 'error');
        connectButton.disabled = false;
        connectButton.textContent = 'Connect Instagram';
    }
});

flowForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const saveButton = document.getElementById('save-flow');
    saveButton.disabled = true;
    try {
        await api('/api/instagram-flow', {
            method: 'POST',
            body: JSON.stringify({
                action: 'save',
                mediaId: selectedMediaId,
                keywordFilter: document.getElementById('keyword-filter').value,
                replyTemplate: document.getElementById('reply-template').value,
                dmTemplate: document.getElementById('dm-template').value,
                dmLink: document.getElementById('dm-link').value,
                isActive: document.getElementById('flow-active').checked
            })
        });
        showNotice('Automation saved.', 'success');
        await loadInstagram();
    } catch (error) {
        showNotice(error.message, 'error');
    } finally {
        saveButton.disabled = false;
    }
});

flowStatusButton.addEventListener('click', () => loadInstagram().catch((error) => showNotice(error.message, 'error')));
initializeDashboard();

window.setInterval(() => {
    if (document.hidden || !session) return;
    for (const status of mediaGrid.querySelectorAll('.flow-status[data-flow-id]')) {
        refreshStatus(status.dataset.flowId, status);
    }
}, 10000);
