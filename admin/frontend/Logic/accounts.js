const supabase = window.supabase.createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_ANON_KEY');
const ADMIN_EMAIL = 'your-email@codevelly.com';

export async function protectAdminRoute() {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || session.user.email !== ADMIN_EMAIL) {
        window.location.href = 'admin-login.html';
    }
}

export async function logoutAdmin() {
    await supabase.auth.signOut();
    window.location.href = 'admin-login.html';
}