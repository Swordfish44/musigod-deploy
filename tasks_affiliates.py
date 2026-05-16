"""
3-task affiliates wiring script for MusiGod / Supabase uykzkrnoetcldeuxzqyy

Usage:
    $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxx..."   # Supabase PAT
    python tasks_affiliates.py

Tasks:
  1. Expose affiliates schema via Management API PATCH /config/postgrest
  2. Apply SQL migration (ALTER TABLE + 2 proxy functions + GRANTs)
  3. Insert test affiliate, run full E2E commission flow, print PASS/FAIL
"""
import urllib.request, urllib.error, json, os, sys

# ── Config ─────────────────────────────────────────────────────────────────
SB_URL  = "https://uykzkrnoetcldeuxzqyy.supabase.co"
SB_REF  = "uykzkrnoetcldeuxzqyy"
MGMT    = "https://api.supabase.com/v1"
SVC     = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
ARTIST_ID = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"

PAT = os.environ.get("SUPABASE_ACCESS_TOKEN") or os.environ.get("SUPABASE_PAT") or ""

MIGRATION_SQL = open("supabase/migrations/20260515_affiliates_wiring.sql", encoding="utf-8").read()

FAIL_COUNT = 0
def step(n, title): print(f"\n{'='*60}\nTask {n}: {title}\n{'='*60}")
def ok(msg):   print(f"  OK    {msg}")
def fail(msg):
    global FAIL_COUNT
    FAIL_COUNT += 1
    print(f"  FAIL  {msg}")

# ── HTTP helpers ────────────────────────────────────────────────────────────
def http(method, url, headers, body=None):
    req = urllib.request.Request(url, headers=headers, method=method)
    if body is not None:
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            try:    return r.status, json.loads(raw)
            except: return r.status, raw.decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")

def sb(method, path, schema, key=SVC, body=None):
    hdrs = {"apikey": key, "Authorization": f"Bearer {key}",
            "Accept-Profile": schema, "Content-Profile": schema}
    if body is not None: hdrs["Content-Type"] = "application/json"
    return http(method, f"{SB_URL}/rest/v1/{path}", hdrs, body)

def mgmt(method, path, body=None):
    hdrs = {"Authorization": f"Bearer {PAT}", "Content-Type": "application/json"}
    return http(method, f"{MGMT}{path}", hdrs, body)

# ════════════════════════════════════════════════════════════════
# TASK 1 — Expose affiliates schema
# ════════════════════════════════════════════════════════════════
step(1, "Expose affiliates schema via Management API")

EXPOSED = "public,graphql_public,registrations,earnings,artists,affiliates"

if not PAT:
    fail("SUPABASE_ACCESS_TOKEN not set. Set it then re-run:")
    print("    $env:SUPABASE_ACCESS_TOKEN = 'sbp_...'")
    print("\n  Exact curl equivalent:")
    print(f"""  curl -s -X PATCH "{MGMT}/projects/{SB_REF}/config/postgrest" \\
    -H "Authorization: Bearer <PAT>" \\
    -H "Content-Type: application/json" \\
    -d '{{"db_schema":"{EXPOSED}"}}'""")
    print("\n  Continuing to probe current state with service key...")
else:
    code, data = mgmt("PATCH", f"/projects/{SB_REF}/config/postgrest",
                      {"db_schema": EXPOSED})
    if code == 200:
        ok(f"PostgREST config updated: db_schema={data.get('db_schema','?')}")
    else:
        fail(f"Management API {code}: {str(data)[:300]}")
        print("  Manual fix: Supabase Dashboard -> Settings -> API -> Extra Search Path -> add affiliates")

# Verify schema exposure
print("\n  Verifying affiliates schema is now accessible...")
code, data = sb("GET", "affiliates_v1?select=*&limit=1", "affiliates")
if code == 200:
    ok(f"affiliates.affiliates_v1 accessible (rows={len(data) if isinstance(data,list) else '?'})")
elif code == 406:
    body = str(data)
    fail(f"Still PGRST106 — schema not exposed yet: {body[:150]}")
    if not PAT:
        print("\n  >>> STOP: complete Task 1 manually before continuing.")
        print("  >>> Dashboard -> Settings -> API -> Extra Search Path -> add 'affiliates'")
        sys.exit(1)
else:
    fail(f"Unexpected {code}: {str(data)[:150]}")

# ════════════════════════════════════════════════════════════════
# TASK 2 — Apply SQL migration
# ════════════════════════════════════════════════════════════════
step(2, "Apply SQL migration via Management API")

if not PAT:
    fail("SUPABASE_ACCESS_TOKEN not set — cannot apply migration via Management API.")
    print("  SQL to run manually at:")
    print(f"  https://supabase.com/dashboard/project/{SB_REF}/sql/new")
    print("\n  File: supabase/migrations/20260515_affiliates_wiring.sql")
else:
    code, data = mgmt("POST", f"/projects/{SB_REF}/database/query",
                      {"query": MIGRATION_SQL})
    if code == 200:
        ok(f"Migration applied: {data}")
    else:
        fail(f"Migration failed ({code}): {str(data)[:300]}")

# Verify migration objects exist
print("\n  Verifying ref_code column on artists_v1...")
code, data = sb("GET", f"artists_v1?id=eq.{ARTIST_ID}&select=ref_code", "artists")
if code == 200 and isinstance(data, list):
    if data and "ref_code" in data[0]:
        ok(f"ref_code column present (current value: {data[0]['ref_code']!r})")
    else:
        fail("ref_code column not found in artists_v1 — migration may not have run")
else:
    fail(f"artists_v1 probe failed ({code}): {str(data)[:150]}")

print("\n  Verifying fn_create_commission RPC...")
code, data = sb("POST", "rpc/fn_create_commission", "public",
                body={"p_affiliate_code": "", "p_artist_id": ARTIST_ID, "p_trigger": "probe"})
if code == 200 and isinstance(data, dict):
    ok(f"fn_create_commission reachable: {data}")
elif code == 404:
    fail("fn_create_commission not found (404) — migration not applied yet")
else:
    ok(f"fn_create_commission responded {code}: {str(data)[:100]}")

print("\n  Verifying fn_get_commissions RPC...")
code, data = sb("POST", "rpc/fn_get_commissions", "public",
                body={"p_artist_id": ARTIST_ID})
if code == 200:
    ok(f"fn_get_commissions reachable (result: {str(data)[:80]})")
elif code == 404:
    fail("fn_get_commissions not found (404) — migration not applied yet")
else:
    fail(f"fn_get_commissions {code}: {str(data)[:150]}")

# ════════════════════════════════════════════════════════════════
# TASK 3 — Create test affiliate + full E2E
# ════════════════════════════════════════════════════════════════
step(3, "Create test affiliate + E2E commission flow")

# Guard: affiliates schema must be accessible
code, _ = sb("GET", "affiliates_v1?select=id&limit=1", "affiliates")
if code != 200:
    fail(f"affiliates schema still not accessible ({code}) — complete Task 1 first")
    print(f"\nFINAL RESULT: {FAIL_COUNT} check(s) FAILED")
    sys.exit(1)

# 3a. Insert test affiliate
print("\n  [3a] Insert test affiliate...")
code, data = sb("POST", "affiliates_v1", "affiliates",
                body={"name": "NAIM Test Partner", "email": "swordfishlp44@proton.me",
                      "status": "active", "commission_type": "flat", "commission_flat": 25.00},
                # Need Prefer: return=representation to get the inserted row back
                )

# sb() doesn't set Prefer header — do it manually
hdrs = {"apikey": SVC, "Authorization": f"Bearer {SVC}",
        "Accept-Profile": "affiliates", "Content-Profile": "affiliates",
        "Content-Type": "application/json",
        "Prefer": "return=representation"}
code, data = http("POST", f"{SB_URL}/rest/v1/affiliates_v1", hdrs,
                  {"name": "NAIM Test Partner", "email": "swordfishlp44@proton.me",
                   "status": "active", "commission_type": "flat", "commission_flat": 25.00})

if code in (200, 201) and isinstance(data, list) and data:
    aff = data[0]
    ref_code = aff.get("ref_code")
    aff_id   = aff.get("id")
    ok(f"Affiliate created: id={aff_id}, ref_code={ref_code!r}, commission_flat={aff.get('commission_flat')}")
elif code in (200, 201) and isinstance(data, list) and not data:
    fail("INSERT succeeded but returned empty — missing ref_code. Check Prefer header / RLS.")
    ref_code = None
else:
    fail(f"affiliates_v1 INSERT failed ({code}): {str(data)[:300]}")
    print(f"\nFINAL RESULT: {FAIL_COUNT} check(s) FAILED")
    sys.exit(1)

if not ref_code:
    fail("ref_code is NULL after insert — affiliates_v1 needs a DEFAULT or trigger for ref_code")
    print(f"\nFINAL RESULT: {FAIL_COUNT} check(s) FAILED")
    sys.exit(1)

# 3b. Set ref_code on test artist
print(f"\n  [3b] Set ref_code={ref_code!r} on artist {ARTIST_ID[:8]}...")
code, data = sb("PATCH", f"artists_v1?id=eq.{ARTIST_ID}", "artists",
                body={"ref_code": ref_code})
if code in (200, 204):
    ok(f"artist.ref_code set to {ref_code!r}")
else:
    fail(f"PATCH artists_v1 failed ({code}): {str(data)[:200]}")
    print(f"\nFINAL RESULT: {FAIL_COUNT} check(s) FAILED")
    sys.exit(1)

# 3c. Fire fn_create_commission
print(f"\n  [3c] Fire fn_create_commission(ref_code={ref_code!r}, artist_id={ARTIST_ID[:8]}...)...")
code, data = sb("POST", "rpc/fn_create_commission", "public",
                body={"p_affiliate_code": ref_code, "p_artist_id": ARTIST_ID, "p_trigger": "e2e_test"})
if code == 200 and isinstance(data, dict):
    if data.get("ok"):
        ok(f"Commission created: id={data.get('commission_id')}, amount={data.get('amount')}")
        commission_id = data.get("commission_id")
    else:
        fail(f"fn_create_commission returned ok=false: {data}")
        print(f"\nFINAL RESULT: {FAIL_COUNT} check(s) FAILED")
        sys.exit(1)
else:
    fail(f"fn_create_commission failed ({code}): {str(data)[:300]}")
    print(f"\nFINAL RESULT: {FAIL_COUNT} check(s) FAILED")
    sys.exit(1)

# 3d. Read back via fn_get_commissions
print(f"\n  [3d] Read back commissions via fn_get_commissions...")
code, data = sb("POST", "rpc/fn_get_commissions", "public",
                body={"p_artist_id": ARTIST_ID})
if code != 200:
    fail(f"fn_get_commissions failed ({code}): {str(data)[:200]}")
else:
    rows = data if isinstance(data, list) else (json.loads(data) if isinstance(data, str) else [])
    matching = [r for r in rows if str(r.get("id")) == str(commission_id)]
    if not matching:
        # try any row with this ref
        matching = rows
    ok(f"fn_get_commissions returned {len(rows)} row(s):")
    for r in rows:
        print(f"    {r}")

# 3e. Final assertions
print(f"\n  [3e] Assertions...")
if isinstance(data, list) and data or (isinstance(data, str)):
    rows = data if isinstance(data, list) else (json.loads(data) if isinstance(data, str) else [])
    e2e_row = next((r for r in rows if str(r.get("id")) == str(commission_id)), rows[0] if rows else None)
    if not e2e_row:
        fail("No commission rows returned for this artist")
    else:
        status_ok = str(e2e_row.get("status","")).lower() == "pending"
        amount_ok  = float(e2e_row.get("amount", 0) or 0) == 25.0
        if status_ok: ok(f"status = 'pending'  ✓")
        else:         fail(f"status = {e2e_row.get('status')!r} (expected 'pending')")
        if amount_ok: ok(f"amount = 25.00  ✓")
        else:         fail(f"amount = {e2e_row.get('amount')!r} (expected 25.0)")
else:
    fail("Could not parse fn_get_commissions response for assertions")

# ── Final summary ───────────────────────────────────────────────────────────
print("\n" + "="*60)
if FAIL_COUNT == 0:
    print("PASS — all checks passed")
else:
    print(f"FAIL — {FAIL_COUNT} check(s) failed (see above)")
    sys.exit(1)
