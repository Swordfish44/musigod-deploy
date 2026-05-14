import requests
import json
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SUPABASE_URL = "https://uykzkrnoetcldeuxzqyy.supabase.co"
SUPABASE_SERVICE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
N8N_BASE = "https://musigod-n8n.onrender.com/api/v1"
N8N_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YWMxNzFmYi0xMzZlLTQ2ZGEtOGU3My02MzhlYjQyYzlmMjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYjljYjdlYjAtMTAwNS00N2JjLTlhNGEtODZjN2U2OGE2ZDU5IiwiaWF0IjoxNzc4NzI3OTgzLCJleHAiOjE3ODEyMzY4MDB9.A0k7EVpOJ9LqrNsvrjz9CRrYPE3nj4SvgY9iwHmjClA"

SB_HEADERS = {
    "apikey": SUPABASE_SERVICE,
    "Authorization": f"Bearer {SUPABASE_SERVICE}",
    "Accept-Profile": "registrations",
}

N8N_HEADERS = {
    "X-N8N-API-KEY": N8N_API_KEY,
}

# ── STEP 4: Query registrations for NAIM ─────────────────────────────────────
print("=" * 60)
print("STEP 4 — Supabase: registrations for NAIM")
print("=" * 60)

r = requests.get(
    f"{SUPABASE_URL}/rest/v1/registrations_v1",
    headers=SB_HEADERS,
    params={
        "select": "*",
        "or": "(artist_name.ilike.*naim*,legal_first_name.ilike.*naim*,legal_last_name.ilike.*naim*)",
        "order": "updated_at.desc",
    },
)
print(f"Status: {r.status_code}")
if not r.ok:
    print("Error:", r.text)
else:
    rows = r.json()
    if not rows:
        print("  No rows found for NAIM.")
    for row in rows:
        print()
        fields = [
            "id", "registration_id", "artist_name", "legal_first_name", "legal_last_name",
            "status", "created_at", "updated_at", "submitted_at", "completed_at",
            "n8n_execution_id", "external_id", "external_status", "last_error",
        ]
        for f in fields:
            if f in row:
                print(f"  {f:<22} {row[f]}")

# ── STEP 5: n8n executions ────────────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 5 — n8n: last 10 executions")
print("=" * 60)

# Build workflow ID → name map
wf_r = requests.get(f"{N8N_BASE}/workflows", headers=N8N_HEADERS)
wf_map = {wf["id"]: wf["name"] for wf in wf_r.json().get("data", [])}

ex_r = requests.get(
    f"{N8N_BASE}/executions",
    headers=N8N_HEADERS,
    params={"limit": 10},
)
print(f"Status: {ex_r.status_code}")
if not ex_r.ok:
    print("Error:", ex_r.text)
else:
    execs = ex_r.json().get("data", [])
    if not execs:
        print("  No executions found.")
    for ex in execs:
        wf_id = ex.get("workflowId", "?")
        wf_name = wf_map.get(wf_id, wf_id)
        status = ex.get("status", "?")
        started = ex.get("startedAt", "?")
        finished = ex.get("stoppedAt", "?")
        ex_id = ex.get("id", "?")
        print(f"  [{ex_id}] {wf_name}")
        print(f"    status={status}  started={started}  finished={finished}")
