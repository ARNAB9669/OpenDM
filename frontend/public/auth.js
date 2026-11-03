const config = window.OPENDM_CONFIG;
const configured = config && config.supabaseUrl !== 'YOUR_SUPABASE_URL' && config.supabaseAnonKey !== 'YOUR_SUPABASE_ANON_KEY';
const supabase = configured ? window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey) : null;

const authForm = document.getElementById('auth-form');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submit-btn');
const messageDiv = document.getElementById('auth-message');

async function checkExistingSession() {
    if (!supabase) return;
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        window.location.href = '/app/dashboard/dashboard.html';
    }
}
checkExistingSession();

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!supabase) {
        messageDiv.style.display = 'block';
        messageDiv.textContent = 'Open DM is not configured yet. Contact the administrator.';
        messageDiv.style.color = 'red';
        return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    const { error } = await supabase.auth.signInWithOtp({
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
