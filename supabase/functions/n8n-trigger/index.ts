const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const N8N_API_KEY = Deno.env.get("N8N_API_KEY")!;
const N8N_WEBHOOK_URL = Deno.env.get("N8N_WEBHOOK_URL")!;

Deno.serve(async () => {
  try {
    const data = await supabaseGet(
      "registrations_v1",
      new URLSearchParams({
        select: [
          "id",
          "artist_id",
          "registration_type",
          "registration_category",
          "assigned_to",
          "instructions",
          "documents_needed",
          "estimated_minutes",
          "portal_sort_order",
          "attempts",
          "error_count",
        ].join(","),
        status: "eq.PENDING",
        error_count: "lt.5",
        order: "portal_sort_order.asc",
        limit: "100",
      }),
      "registrations",
    );

    if (!data || data.length === 0) {
      return json({ ok: true, message: "No pending registrations", count: 0 });
    }

    const artistIds = [...new Set(data.map((r: any) => r.artist_id).filter(Boolean))];
    const artistMap = await loadArtists(artistIds);
    await mergeWriterProfiles(artistMap, artistIds);
    await mergePublisherProfiles(artistMap, artistIds);

    const payload = {
      event: "registration.batch_ready",
      triggered_at: new Date().toISOString(),
      count: data.length,
      registrations: data.map((r: any) => {
        const artist = artistMap.get(r.artist_id) || {};
        return {
          id: r.id,
          artist_id: r.artist_id,
          artist_name: artist.artist_name ?? null,
          legal_name: [artist.legal_first_name, artist.legal_last_name].filter(Boolean).join(" "),
          email: artist.email ?? null,
          publisher_name: artist.publisher_name ?? null,
          pro_affiliation: artist.pro_affiliation ?? null,
          plan_tier: artist.plan_tier ?? null,
          registration_type: r.registration_type,
          registration_category: r.registration_category,
          assigned_to: r.assigned_to,
          instructions: r.instructions,
          documents_needed: r.documents_needed,
          estimated_minutes: r.estimated_minutes,
          portal_sort_order: r.portal_sort_order,
          attempts: r.attempts,
          error_count: r.error_count,
        };
      }),
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
      throw new Error(`n8n rejected payload: ${n8nRes.status} - ${errText}`);
    }

    const n8nBody = await n8nRes.json().catch(() => ({}));
    return json({ ok: true, registrations_sent: data.length, n8n_response: n8nBody });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("n8n-trigger error:", message);
    return json({ ok: false, error: message }, 500);
  }
});

async function loadArtists(artistIds: string[]) {
  const map = new Map<string, any>();
  if (!artistIds.length) return map;

  const artists = await supabaseGet(
    "artists_v1",
    new URLSearchParams({
      select: "id,artist_name,legal_first_name,legal_last_name,email,plan_tier",
      id: `in.(${artistIds.join(",")})`,
    }),
    "artists",
  );

  artists.forEach((artist: any) => map.set(artist.id, artist));
  return map;
}

async function mergeWriterProfiles(artistMap: Map<string, any>, artistIds: string[]) {
  if (!artistIds.length) return;
  const writers = await supabaseGet(
    "writer_profiles_v1",
    new URLSearchParams({
      select: "artist_id,pro_affiliation",
      artist_id: `in.(${artistIds.join(",")})`,
    }),
    "artists",
  ).catch(() => []);

  writers.forEach((writer: any) => {
    const artist = artistMap.get(writer.artist_id);
    if (artist) artist.pro_affiliation = writer.pro_affiliation ?? null;
  });
}

async function mergePublisherProfiles(artistMap: Map<string, any>, artistIds: string[]) {
  if (!artistIds.length) return;
  const publishers = await supabaseGet(
    "publisher_profiles_v1",
    new URLSearchParams({
      select: "artist_id,publisher_name",
      artist_id: `in.(${artistIds.join(",")})`,
    }),
    "artists",
  ).catch(() => []);

  publishers.forEach((publisher: any) => {
    const artist = artistMap.get(publisher.artist_id);
    if (artist) artist.publisher_name = publisher.publisher_name ?? null;
  });
}

async function supabaseGet(table: string, params: URLSearchParams, schema: string) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${params.toString()}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Accept-Profile": schema,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase GET ${table} failed: ${response.status} ${text}`);
  return text ? JSON.parse(text) : [];
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
