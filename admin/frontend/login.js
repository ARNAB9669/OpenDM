const config = window.OPENDM_CONFIG;
const status = document.getElementById('login-status');
const form = document.getElementById('login-form');
const button = document.getElementById('submit-btn');
const configured = config && config.supabaseUrl !== 'YOUR_SUPABASE_URL' && config.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const supabase = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

if (supabase) {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) window.location.replace('/admin/admin.html');
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!supabase) {
        status.textContent = 'Open DM is not configured yet.';
        return;
    }
    button.disabled = true;
    const { error } = await supabase.auth.signInWithOtp({
        email: document.getElementById('email').value,
        options: { emailRedirectTo: `${window.location.origin}/admin/admin.html`, shouldCreateUser: false }
    });
    status.textContent = error ? error.message : 'Check your inbox for the sign-in link.';
    button.disabled = false;
});
