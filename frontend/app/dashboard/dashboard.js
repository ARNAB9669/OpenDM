const config = window.OPENDM_CONFIG;
const message = document.getElementById('welcome-message');
const logoutButton = document.getElementById('logout-btn');

async function initializeDashboard() {
    if (!config || config.supabaseUrl === 'YOUR_SUPABASE_URL' || config.supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY') {
        message.textContent = 'Open DM is not configured yet.';
        return;
    }

    try {
        const supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
        const { data: { session } } = await supabase.auth.getSession();
        if (!session) {
            window.location.replace('/auth.html');
            return;
        }

        const response = await fetch('/api/client-session', {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        if (!response.ok) {
            const details = await response.json().catch(() => ({}));
            message.textContent = details.error || 'Could not load your workspace. Please contact the administrator.';
            return;
        }

        const { workspaceName } = await response.json();
        message.textContent = `Signed in as ${session.user.email}. Workspace: ${workspaceName}.`;
        logoutButton.addEventListener('click', async () => {
            await supabase.auth.signOut();
            window.location.replace('/auth.html');
        });
    } catch (error) {
        console.error('Could not initialize the client dashboard:', error);
        message.textContent = 'Could not load your workspace. Refresh the page or contact the administrator.';
    }
}

initializeDashboard();
