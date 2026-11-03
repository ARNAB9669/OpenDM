const config = window.OPENDM_CONFIG;
const message = document.getElementById('welcome-message');
const logoutButton = document.getElementById('logout-btn');

if (!config || config.supabaseUrl === 'YOUR_SUPABASE_URL' || config.supabaseAnonKey === 'YOUR_SUPABASE_ANON_KEY') {
    message.textContent = 'Open DM is not configured yet.';
} else {
    const supabase = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        window.location.replace('/auth.html');
    } else {
        const response = await fetch('/api/client-session', {
            headers: { Authorization: `Bearer ${session.access_token}` }
        });
        if (!response.ok) {
            await supabase.auth.signOut();
            window.location.replace('/auth.html');
        } else {
            const { workspaceName } = await response.json();
            message.textContent = `Signed in as ${session.user.email}. Workspace: ${workspaceName}.`;
        }
    }
    logoutButton.addEventListener('click', async () => {
        await supabase.auth.signOut();
        window.location.replace('/auth.html');
    });
}
