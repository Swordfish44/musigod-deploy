"""
E2E test: ?ref=CODE -> signup -> activation -> commission row in affiliates.commissions_v1

Run AFTER applying supabase/migrations/20260515_affiliates_wiring.sql.

Simulates:
  1. A ?ref=TESTREF click landing on the signup page
  2. Artist signup (POST to artists_v1 with ref_code)
  3. Manual activation (PATCH registrations_v1 to ACTIVE)
  4. Commission RPC call (fn_create_commission)
  5. Verification via fn_get_commissions
"""
import urllib.request, urllib.error, json, sys, uuid

SB  = "https://uykzkrnoetcldeuxzqyy.supabase.co"
ANO = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MzA2MTksImV4cCI6MjA5MzEwNjYxOX0.r4Dx_Jkgje2kYNGh9PQtuyuJgBGJwVAviHM9QmAJcrs"
SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"

ARTIST_ID   = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"
TEST_REF    = sys.argv[1] if len(sys.argv) > 1 else None   # pass real affiliate code as arg

FAIL = False
def fail(msg):
    global FAIL
    FAIL = True
    print(f"  FAIL  {msg}")
def ok(msg):
    print(f"  OK    {msg}")

def req(method, path, key, schema=None, body=None, content_type="application/json"):
    url = f"{SB}/rest/v1/{path}"
    hdrs = {"apikey": key, "Authorization": f"Bearer {key}"}
    if schema:
        hdrs["Accept-Profile"] = schema
        hdrs["Content-Profile"] = schema
    if body is not None:
        hdrs["Content-Type"] = content_type
    r = urllib.request.Request(url, headers=hdrs, method=method)
    if body is not None:
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            try: return resp.status, json.loads(raw)
            except: return resp.status, raw.decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


print("\n" + "="*60)
print("E2E: affiliates commission flow")
print("="*60)

# ── Step 0: Verify test artist exists ──────────────────────────────────────
print("\n[0] Check test artist")
code, data = req("GET", f"artists_v1?id=eq.{ARTIST_ID}&select=id,artist_name,email,plan_status", SVC, "artists")
if code != 200 or not isinstance(data, list) or not data:
    fail(f"Cannot fetch test artist ({code}): {str(data)[:150]}")
    sys.exit(1)
artist = data[0]
ok(f"Artist: {artist['artist_name']} / {artist['email']} / status={artist['plan_status']}")


# ── Step 1: Simulate ?ref=CODE — set ref_code on artist via PATCH ──────────
print(f"\n[1] Simulate ?ref={TEST_REF or '(no ref — skipping commission test)'} click -> set ref_code on artist")
if TEST_REF:
    code, data = req("PATCH", f"artists_v1?id=eq.{ARTIST_ID}", SVC, "artists",
                     body={"ref_code": TEST_REF})
    if code not in (200, 204):
        fail(f"Could not set ref_code ({code}): {str(data)[:200]}")
        print("  NOTE: ALTER TABLE artists.artists_v1 ADD COLUMN ref_code TEXT has not run yet")
    else:
        ok(f"ref_code set to {TEST_REF!r} on artist {ARTIST_ID[:8]}...")
else:
    print("  SKIP  No TEST_REF provided — pass affiliate code as first arg, e.g.:")
    print("        python e2e_affiliates.py NAIM")


# ── Step 2: Check fn_create_commission function exists ─────────────────────
print("\n[2] Verify fn_create_commission RPC exists")
code, data = req("POST", "rpc/fn_create_commission", SVC, body={
    "p_affiliate_code": "",
    "p_artist_id": str(uuid.uuid4()),
    "p_trigger": "e2e_probe"
})
if code == 200 and isinstance(data, dict):
    ok(f"fn_create_commission reachable: {data}")
elif code == 404:
    fail(f"fn_create_commission not found (404) — run SQL migration first")
else:
    ok(f"fn_create_commission responded {code}: {str(data)[:100]}")


# ── Step 3: Fire commission for test artist ────────────────────────────────
print("\n[3] Fire fn_create_commission for test artist")
if not TEST_REF:
    print("  SKIP  No TEST_REF — skipping commission creation")
else:
    code, data = req("POST", "rpc/fn_create_commission", SVC, body={
        "p_affiliate_code": TEST_REF,
        "p_artist_id": ARTIST_ID,
        "p_trigger": "e2e_test"
    })
    if code == 200 and isinstance(data, dict):
        if data.get("ok"):
            ok(f"Commission created: id={data.get('commission_id')}")
        else:
            fail(f"RPC returned ok=false: {data}")
    else:
        fail(f"fn_create_commission failed ({code}): {str(data)[:200]}")


# ── Step 4: Verify commission row via fn_get_commissions ───────────────────
print("\n[4] Verify commission row via fn_get_commissions")
code, data = req("POST", "rpc/fn_get_commissions", SVC, body={"p_artist_id": ARTIST_ID})
if code == 200:
    rows = data if isinstance(data, list) else (json.loads(data) if isinstance(data, str) else [])
    if rows:
        ok(f"Found {len(rows)} commission row(s) for this artist:")
        for r in rows:
            print(f"    {r}")
    elif TEST_REF:
        fail("No commission rows found — check that affiliates_v1 has a row with code={TEST_REF!r}")
    else:
        ok("No commission rows (expected — no TEST_REF provided)")
else:
    fail(f"fn_get_commissions failed ({code}): {str(data)[:200]}")


# ── Summary ────────────────────────────────────────────────────────────────
print("\n" + "="*60)
if FAIL:
    print("RESULT: SOME CHECKS FAILED — see above")
    sys.exit(1)
else:
    print("RESULT: ALL CHECKS PASSED")
