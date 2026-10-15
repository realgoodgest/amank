import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.57.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? 'https://YOUR-PRODUCTION-DOMAIN.example',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Vary': 'Origin',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
  const origin = req.headers.get('origin');
  const allowed = Deno.env.get('ALLOWED_ORIGIN');
  if (!allowed) return json({ error: 'server_not_configured' }, 500);
  if (!origin || origin !== allowed) return json({ error: 'origin_not_allowed' }, 403);
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return json({ error: 'authentication_required' }, 401);
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const workspaceId = Deno.env.get('AUTOORDER_WORKSPACE_ID');
  if (!url || !anonKey || !serviceKey || !workspaceId) return json({ error: 'server_not_configured' }, 500);

  const userClient = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: { user }, error: userError } = await userClient.auth.getUser();
  if (userError || !user) return json({ error: 'invalid_session' }, 401);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: workspace, error: workspaceError } = await admin.from('workspaces').select('id').eq('id', workspaceId).maybeSingle();
  if (workspaceError || !workspace) return json({ error: 'store_not_configured' }, 500);

  const { data: existing, error: existingError } = await admin.from('workspace_members').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle();
  if (existingError) return json({ error: 'membership_lookup_failed' }, 500);
  if (existing && existing.role !== 'buyer') return json({ ok: true, role: existing.role, workspace_id: workspaceId });
  if (!existing) {
    const { error: insertError } = await admin.from('workspace_members').insert({ workspace_id: workspaceId, user_id: user.id, role: 'buyer' });
    if (insertError && insertError.code !== '23505') return json({ error: 'membership_create_failed' }, 500);
  }
  const metadataName = typeof user.user_metadata?.display_name === 'string' ? user.user_metadata.display_name.slice(0, 120) : '';
  const { error: profileError } = await admin.from('profiles').upsert({ user_id: user.id, display_name: metadataName }, { onConflict: 'user_id', ignoreDuplicates: true });
  if (profileError) return json({ error: 'profile_setup_failed' }, 500);
  return json({ ok: true, role: 'buyer', workspace_id: workspaceId });
});
