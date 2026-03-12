'use strict';
require('dotenv').config();
const express         = require('express');
const cors            = require('cors');
const { createClient } = require('@supabase/supabase-js');
const path            = require('path');

const app = express();

const supabaseUrl  = process.env.SUPABASE_URL;
const supabaseKey  = process.env.SUPABASE_ANON_KEY;
const INTERNAL_KEY = process.env.INTERNAL_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

app.use(cors());
app.use(express.json());

// ─── Auto-migration ─────────────────────────────────────────────────────────
(async () => {
    try {
        await supabase.rpc('exec_sql', {
            sql: "ALTER TABLE operacoes ADD COLUMN IF NOT EXISTS data_jogo TEXT DEFAULT NULL;"
        });
    } catch (_) {}
})();

// ─── Helpers ─────────────────────────────────────────────────────────────────
function getClientForUser(accessToken) {
    return createClient(supabaseUrl, supabaseKey, {
        global: { headers: { Authorization: `Bearer ${accessToken}` } }
    });
}
function extractToken(req) {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) return null;
    return auth.split(' ')[1];
}

// ─── POST /api/auth/login ──────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    const { email } = req.body;
    if (!email || !email.includes('@'))
        return res.status(400).json({ error: 'E-mail inválido.' });

    const cleanEmail = email.trim().toLowerCase();

    let { data, error } = await supabase.auth.signInWithPassword({
        email: cleanEmail, password: INTERNAL_KEY
    });

    if (error && (error.message.includes('Invalid login credentials') || error.message.includes('invalid_grant'))) {
        const { error: signUpError } = await supabase.auth.signUp({
            email: cleanEmail,
            password: INTERNAL_KEY,
            options: { emailRedirectTo: null }
        });
        if (signUpError && !signUpError.message.includes('already registered'))
            return res.status(400).json({ error: 'Erro ao criar conta: ' + signUpError.message });

        const second = await supabase.auth.signInWithPassword({
            email: cleanEmail, password: INTERNAL_KEY
        });
        data  = second.data;
        error = second.error;
    }

    if (error) {
        if (error.message.includes('Email not confirmed'))
            return res.status(403).json({ error: 'email_not_confirmed' });
        return res.status(400).json({ error: error.message });
    }

    return res.json({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        user: { id: data.user.id, email: data.user.email }
    });
});

// ─── POST /api/auth/refresh ────────────────────────────────────────────────
app.post('/api/auth/refresh', async (req, res) => {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Token inválido.' });
    const { data, error } = await supabase.auth.refreshSession({ refresh_token });
    if (error) return res.status(401).json({ error: error.message });
    return res.json({
        access_token:  data.session.access_token,
        refresh_token: data.session.refresh_token,
        user: { id: data.user.id, email: data.user.email }
    });
});

// ─── GET /api/settings ─────────────────────────────────────────────────────
app.get('/api/settings', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    let { data, error } = await client.from('user_settings')
        .select('banca_inicial').eq('user_id', user.id).single();

    if (error && error.code === 'PGRST116') {
        await client.from('user_settings').insert({ user_id: user.id, banca_inicial: 0 });
        data = { banca_inicial: 0 };
    } else if (error) {
        return res.status(500).json({ error: error.message });
    }
    res.json(data);
});

// ─── PUT /api/settings ─────────────────────────────────────────────────────
app.put('/api/settings', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const { banca_inicial } = req.body;
    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    const { error } = await client.from('user_settings')
        .update({ banca_inicial, updated_at: new Date() })
        .eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// ─── GET /api/operacoes ────────────────────────────────────────────────────
app.get('/api/operacoes', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    const { data, error } = await client.from('operacoes')
        .select('*').eq('user_id', user.id)
        .order('created_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── POST /api/operacoes ───────────────────────────────────────────────────
app.post('/api/operacoes', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    const { evento, mercado, stake1, stake2, lucro, hora, casa1, casa2, data_jogo } = req.body;
    const date = req.body.data;

    const { data: inserted, error } = await client.from('operacoes')
        .insert([{
            user_id: user.id, data: date, hora, data_jogo,
            evento, mercado, stake1, stake2, lucro,
            casa1, casa2, sacado: false
        }])
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(inserted);
});

// ─── PUT /api/operacoes/:id/sacado ─────────────────────────────────────────
app.put('/api/operacoes/:id/sacado', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    const { sacado } = req.body;
    const { data, error } = await client.from('operacoes')
        .update({ sacado })
        .eq('id', req.params.id)
        .eq('user_id', user.id)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── PUT /api/operacoes/:id ────────────────────────────────────────────────
app.put('/api/operacoes/:id', async (req, res) => {
    console.log(`[PUT] Atualizando operação ${req.params.id}`);
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    const { evento, mercado, stake1, stake2, lucro, hora, casa1, casa2, data_jogo } = req.body;
    const date = req.body.data;

    const { data, error } = await client.from('operacoes')
        .update({
            data: date, hora, data_jogo,
            evento, mercado, stake1, stake2, lucro,
            casa1, casa2
        })
        .eq('id', req.params.id)
        .eq('user_id', user.id)
        .select().single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// ─── DELETE /api/operacoes/:id ─────────────────────────────────────────────
app.delete('/api/operacoes/:id', async (req, res) => {
    const token = extractToken(req);
    if (!token) return res.status(401).json({ error: 'Não autenticado.' });

    const client = getClientForUser(token);
    const { data: { user } } = await client.auth.getUser();
    if (!user) return res.status(401).json({ error: 'Token inválido.' });

    const { error } = await client.from('operacoes')
        .delete()
        .eq('id', req.params.id)
        .eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.use((req, res, next) => {
    console.log(`[ROUTE NOT FOUND] ${req.method} ${req.url}`);
    next();
});

// ─── SERVER INICIADO (LOCAL OU VERCEL) ──────────────────────────────────────
if (require.main === module) {
    // Se o arquivo for rodado direto no terminal local (npm run dev)
    const PORT = process.env.PORT || 3000;
    app.use(express.static(path.join(__dirname)));
    app.listen(PORT, () => {
        console.log(`\n============================`);
        console.log(` Surebet Manager - LOCAL SERVER`);
        console.log(` http://localhost:${PORT}`);
        console.log(`============================\n`);
    });
}

// Para a Vercel utilizar como serverless
module.exports = app;
