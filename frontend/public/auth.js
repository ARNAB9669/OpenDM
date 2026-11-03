const config = window.OPENDM_CONFIG;
const configured = config && config.supabaseUrl !== 'YOUR_SUPABASE_URL' && config.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
// The Supabase CDN also exposes a global named `supabase`. Avoid declaring a
// top-level lexical binding with that same name in this classic script.
const supabaseClient = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

const authForm = document.getElementById('auth-form');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submit-btn');
const messageDiv = document.getElementById('auth-message');

async function checkExistingSession() {
    if (!supabaseClient) return;
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
        window.location.href = '/app/dashboard/dashboard.html';
    }
}
checkExistingSession();

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabaseClient) {
        messageDiv.style.display = 'block';
        messageDiv.textContent = 'Open DM is not configured yet. Contact the administrator.';
        messageDiv.style.color = 'red';
        return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    const { error } = await supabaseClient.auth.signInWithOtp({
        email: emailInput.value,
        options: {
            emailRedirectTo: window.location.origin + '/app/dashboard/dashboard.html',
            shouldCreateUser: false
        }
    });

    messageDiv.style.display = 'block';
    if (error) {
        messageDiv.textContent = error.message;
        messageDiv.style.color = 'red';
        submitBtn.disabled = false;
        submitBtn.textContent = 'Send Magic Link';
    } else {
        messageDiv.textContent = 'Check your inbox for the magic link!';
        messageDiv.style.color = 'green';
    }
});
