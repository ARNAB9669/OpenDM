import { createClient } from '@supabase/supabase-js';

function required(name) {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required server environment variable: ${name}`);
    return value;
}

export function adminClient() {
    return createClient(required('SUPABASE_URL'), required('SUPABASE_SERVICE_ROLE_KEY'), {
        auth: { autoRefreshToken: false, persistSession: false }
    });
}

export async function requireAdmin(req, res) {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: 'Sign in as an administrator.' });
        return null;
    }

    const { data: { user }, error } = await adminClient().auth.getUser(token);
    const adminEmail = required('ADMIN_EMAIL').trim().toLowerCase();
    if (error || !user || user.email?.toLowerCase() !== adminEmail) {
        res.status(403).json({ error: 'Administrator access required.' });
        return null;
    }
    return user;
}

export async function requireUser(req, res) {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!token) {
        res.status(401).json({ error: 'Sign in required.' });
        return null;
    }
    const { data: { user }, error } = await adminClient().auth.getUser(token);
    if (error || !user) {
        res.status(401).json({ error: 'Invalid session.' });
        return null;
    }
    return user;
}
