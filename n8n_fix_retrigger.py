import requests
import json
import time
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SUPABASE_URL = "https://uykzkrnoetcldeuxzqyy.supabase.co"
SUPABASE_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
ARTIST_ID    = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"
N8N_WEBHOOK  = "https://musigod-n8n.onrender.com/webhook/registration-task"
N8N_BASE     = "https://musigod-n8n.onrender.com/api/v1"
N8N_KEY      = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YWMxNzFmYi0xMzZlLTQ2ZGEtOGU3My02MzhlYjQyYzlmMjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYjljYjdlYjAtMTAwNS00N2JjLTlhNGEtODZjN2U2OGE2ZDU5IiwiaWF0IjoxNzc4NzI3OTgzLCJleHAiOjE3ODEyMzY4MDB9.A0k7EVpOJ9LqrNsvrjz9CRrYPE3nj4SvgY9iwHmjClA"

SB_READ  = {"apikey": SUPABASE_SVC, "Authorization": f"Bearer {SUPABASE_SVC}",
            "Accept-Profile": "registrations"}
SB_WRITE = {**SB_READ, "Content-Type": "application/json",
            "Content-Profile": "registrations", "Prefer": "return=representation"}
N8N_H    = {"X-N8N-API-KEY": N8N_KEY}

# ── STEP 1: Find all stalled IN_PROGRESS rows ─────────────────────────────────
print("=" * 60)
print("STEP 1 — Find stalled IN_PROGRESS rows for NAIM")
print("=" * 60)
r = requests.get(f"{SUPABASE_URL}/rest/v1/registrations_v1", headers=SB_READ,
                 params={"artist_id": f"eq.{ARTIST_ID}",
                         "status": "eq.IN_PROGRESS",
                         "n8n_execution_id": "is.null",
                         "select": "id,status,action_url,last_error,updated_at",
                         "order": "updated_at.desc"})
r.raise_for_status()
stalled = r.json()
print(f"  Found {len(stalled)} stalled IN_PROGRESS rows (n8n_execution_id IS NULL)")

# ── STEP 2: Reset stalled rows to PENDING ─────────────────────────────────────
print()
print("=" * 60)
print("STEP 2 — Reset stalled rows → status=PENDING")
print("=" * 60)
if stalled:
    patch = requests.patch(
        f"{SUPABASE_URL}/rest/v1/registrations_v1",
        headers=SB_WRITE,
        params={"artist_id": f"eq.{ARTIST_ID}",
                "status": "eq.IN_PROGRESS",
                "n8n_execution_id": "is.null"},
        json={"status": "PENDING", "last_error": None},
    )
    if patch.ok:
        updated = patch.json()
        print(f"  Reset {len(updated)} rows to PENDING  ({patch.status_code})")
    else:
        print(f"  FAILED {patch.status_code}: {patch.text[:300]}")
        sys.exit(1)
else:
    print("  No stalled rows to reset.")

# ── STEP 3: Pick best candidate to trigger ────────────────────────────────────
print()
print("=" * 60)
print("STEP 3 — Pick a PENDING row to trigger")
print("=" * 60)
# Prefer rows that have an action_url (real external task)
r2 = requests.get(f"{SUPABASE_URL}/rest/v1/registrations_v1", headers=SB_READ,
                  params={"artist_id": f"eq.{ARTIST_ID}",
                          "status": "eq.PENDING",
                          "action_url": "not.is.null",
                          "select": "id,status,action_url,updated_at",
                          "order": "updated_at.asc",
                          "limit": "1"})
r2.raise_for_status()
candidates = r2.json()

if not candidates:
    # Fall back to any PENDING row
    r3 = requests.get(f"{SUPABASE_URL}/rest/v1/registrations_v1", headers=SB_READ,
                      params={"artist_id": f"eq.{ARTIST_ID}",
                              "status": "eq.PENDING",
                              "select": "id,status,action_url,updated_at",
                              "order": "updated_at.asc",
                              "limit": "1"})
    r3.raise_for_status()
    candidates = r3.json()

if not candidates:
    print("  No PENDING rows found — nothing to trigger.")
    sys.exit(1)

target = candidates[0]
reg_id = target["id"]
print(f"  Selected row: {reg_id}")
print(f"  action_url:   {target.get('action_url')}")
print(f"  status:       {target.get('status')}")

# ── STEP 4: Trigger webhook with correct registration_id ──────────────────────
print()
print("=" * 60)
print("STEP 4 — POST to /webhook/registration-task")
print("=" * 60)
payload = {"registration_id": reg_id}
print(f"  Body: {json.dumps(payload)}")
trig = requests.post(N8N_WEBHOOK, headers={"Content-Type": "application/json"},
                     json=payload, timeout=30)
print(f"  Response HTTP: {trig.status_code}")
try:
    print(f"  Response body: {json.dumps(trig.json(), indent=2)}")
except Exception:
    print(f"  Response body (raw): {trig.text[:300]}")

# ── STEP 5: Wait and check result ─────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 5 — Waiting 8s then checking row + executions")
print("=" * 60)
time.sleep(8)

# Re-query the specific row
row_r = requests.get(f"{SUPABASE_URL}/rest/v1/registrations_v1", headers=SB_READ,
                     params={"id": f"eq.{reg_id}", "select": "*"})
row_r.raise_for_status()
rows = row_r.json()
if rows:
    row = rows[0]
    print(f"  Row after trigger:")
    for f in ["id", "status", "n8n_execution_id", "last_error", "updated_at", "submitted_at", "action_url"]:
        if f in row:
            print(f"    {f:<22} {row[f]}")

# Latest n8n executions
ex_r = requests.get(f"{N8N_BASE}/executions", headers=N8N_H, params={"limit": 5})
wf_r = requests.get(f"{N8N_BASE}/workflows", headers=N8N_H)
wf_map = {w["id"]: w["name"] for w in wf_r.json().get("data", [])}
execs = ex_r.json().get("data", [])

print()
print("  Latest n8n executions:")
for ex in execs:
    wf_name = wf_map.get(ex.get("workflowId", ""), "?")
    status  = ex.get("status", "?")
    started = ex.get("startedAt", "?")
    eid     = ex.get("id", "?")
    flag    = "✓" if status == "success" else "✗"
    print(f"  {flag} [{eid}] {wf_name}  status={status}  started={started}")

# If latest exec errored, fetch its error
latest = execs[0] if execs else None
if latest and latest.get("status") == "error":
    detail = requests.get(f"{N8N_BASE}/executions/{latest['id']}",
                          headers=N8N_H, params={"includeData": "true"}).json()
    err = detail.get("data", {}).get("resultData", {}).get("error", {})
    print(f"\n  Error on [{latest['id']}]: {err.get('message')} — {err.get('description')}")
    print(f"  Node: {err.get('node', {}).get('name') if err.get('node') else 'unknown'}")

# ── STEP 6: Report ────────────────────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 6 — Summary")
print("=" * 60)
row_status = rows[0].get("status") if rows else "unknown"
n8n_exec   = rows[0].get("n8n_execution_id") if rows else None
last_err   = rows[0].get("last_error") if rows else None
latest_ok  = latest and latest.get("status") == "success"

print(f"  Stalled rows reset:   {len(stalled)}")
print(f"  Triggered row:        {reg_id}")
print(f"  Webhook response:     {trig.status_code}")
print(f"  Row status now:       {row_status}")
print(f"  n8n_execution_id:     {n8n_exec}")
print(f"  last_error:           {last_err}")
print(f"  Latest n8n exec:      {'SUCCESS' if latest_ok else 'FAILED/PENDING'}")
