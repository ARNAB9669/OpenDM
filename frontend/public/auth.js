// Replace with your actual Supabase project URL and anon key
const supabase = window.supabase.createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_ANON_KEY');

const authForm = document.getElementById('auth-form');
const emailInput = document.getElementById('email');
const submitBtn = document.getElementById('submit-btn');
const messageDiv = document.getElementById('auth-message');

async function checkExistingSession() {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
        window.location.href = '/app/dashboard/dashboard.html';
    }
}
checkExistingSession();

authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending...';

    const { error } = await supabase.auth.signInWithOtp({
        email: emailInput.value,
        options: {
            emailRedirectTo: window.location.origin + '/app/dashboard/dashboard.html'
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