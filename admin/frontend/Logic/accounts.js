const config = window.OPENDM_CONFIG;
const configured = config && config.supabaseUrl !== 'YOUR_SUPABASE_URL' && config.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const supabase = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

export async function protectAdminRoute() {
    if (!supabase) {
        window.location.replace('/admin/login.html');
        return false;
    }
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
        window.location.replace('/admin/login.html');
        return false;
    }
    const response = await fetch('/api/admin-session', { headers: { Authorization: `Bearer ${session.access_token}` } });
    if (!response.ok) {
        await supabase.auth.signOut();
        window.location.replace('/admin/login.html');
        return false;
    }
    return true;
}

export async function getAccessToken() {
    const { data: { session } } = await supabase.auth.getSession();
    return session?.access_token || '';
}

export async function logoutAdmin() {
    if (supabase) await supabase.auth.signOut();
    window.location.href = '/admin/login.html';
}
