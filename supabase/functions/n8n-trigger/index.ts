import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const N8N_API_KEY = Deno.env.get("N8N_API_KEY")!;
const N8N_WEBHOOK_URL = Deno.env.get("N8N_WEBHOOK_URL")!;

Deno.serve(async (req) => {
  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data, error: qErr } = await supabase
      .from("registrations_v1")
      .select(`
        id,
        registration_type,
        registration_category,
        assigned_to,
        instructions,
        documents_needed,
        estimated_minutes,
        portal_sort_order,
        attempts,
        error_count,
        artists_v1!inner (
          id,
          artist_name,
          legal_first_name,
          legal_last_name,
          email,
          plan_tier,
          writer_profiles_v1 ( pro_affiliation ),
          publisher_profiles_v1 ( publisher_name )
        )
      `)
      .schema("registrations")
      .eq("status", "PENDING")
      .lt("error_count", 5)
      .order("portal_sort_order", { ascending: true })
      .limit(100);

    if (qErr) throw new Error(qErr.message);
    if (!data || data.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "No pending registrations", count: 0 }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    const payload = {
      event: "registration.batch_ready",
      triggered_at: new Date().toISOString(),
      count: data.length,
      registrations: data.map((r: any) => ({
        id: r.id,
        artist_id: r.artists_v1.id,
        artist_name: r.artists_v1.artist_name,
        legal_name: `${r.artists_v1.legal_first_name} ${r.artists_v1.legal_last_name}`,
        email: r.artists_v1.email,
        publisher_name: r.artists_v1.publisher_profiles_v1?.[0]?.publisher_name ?? null,
        pro_affiliation: r.artists_v1.writer_profiles_v1?.[0]?.pro_affiliation ?? null,
        plan_tier: r.artists_v1.plan_tier,
        registration_type: r.registration_type,
        registration_category: r.registration_category,
        assigned_to: r.assigned_to,
        instructions: r.instructions,
        documents_needed: r.documents_needed,
        estimated_minutes: r.estimated_minutes,
        portal_sort_order: r.portal_sort_order,
        attempts: r.attempts,
        error_count: r.error_count,
      })),
    };

    const n8nRes = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": N8N_API_KEY,
      },
      body: JSON.stringify(payload),
    });

    if (!n8nRes.ok) {
      const errText = await n8nRes.text();
      throw new Error(`n8n rejected payload: ${n8nRes.status} — ${errText}`);
    }

    const n8nBody = await n8nRes.json().catch(() => ({}));

    return new Response(
      JSON.stringify({
        ok: true,
        registrations_sent: data.length,
        n8n_response: n8nBody,
      }),
      { headers: { "Content-Type": "application/json" } }
    );

  } catch (err: any) {
    console.error("n8n-trigger error:", err.message);
    return new Response(
      JSON.stringify({ ok: false, error: err.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
