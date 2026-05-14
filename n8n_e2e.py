import requests
import json
import time
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SUPABASE_URL    = "https://uykzkrnoetcldeuxzqyy.supabase.co"
SUPABASE_SVC    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
ARTIST_ID       = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"
N8N_WEBHOOK     = "https://musigod-n8n.onrender.com/webhook/registration-task"
N8N_BASE        = "https://musigod-n8n.onrender.com/api/v1"
N8N_API_KEY     = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YWMxNzFmYi0xMzZlLTQ2ZGEtOGU3My02MzhlYjQyYzlmMjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYjljYjdlYjAtMTAwNS00N2JjLTlhNGEtODZjN2U2OGE2ZDU5IiwiaWF0IjoxNzc4NzI3OTgzLCJleHAiOjE3ODEyMzY4MDB9.A0k7EVpOJ9LqrNsvrjz9CRrYPE3nj4SvgY9iwHmjClA"

SB_READ  = {"apikey": SUPABASE_SVC, "Authorization": f"Bearer {SUPABASE_SVC}",
            "Accept-Profile": "registrations"}
SB_WRITE = {**SB_READ, "Content-Type": "application/json", "Content-Profile": "registrations",
            "Prefer": "return=representation"}
N8N_H    = {"X-N8N-API-KEY": N8N_API_KEY}

KEY_FIELDS = ["id", "registration_id", "artist_id", "status", "plan_status",
              "action_url", "created_at", "updated_at", "submitted_at",
              "n8n_execution_id", "external_id", "external_status", "last_error"]

def print_rows(rows, label=""):
    if label:
        print(f"\n  {label}")
    if not rows:
        print("  (no rows)")
        return
    for row in rows:
        print(f"  --- row id={row.get('id','?')} ---")
        for f in KEY_FIELDS:
            if f in row:
                print(f"    {f:<22} {row[f]}")

def get_naim_rows():
    r = requests.get(f"{SUPABASE_URL}/rest/v1/registrations_v1",
                     headers=SB_READ,
                     params={"select": "*", "artist_id": f"eq.{ARTIST_ID}",
                             "order": "created_at.asc"})
    r.raise_for_status()
    return r.json()

# ── STEP 1: Current state ─────────────────────────────────────────────────────
print("=" * 60)
print("STEP 1 — Current state in registrations_v1 for NAIM")
print("=" * 60)
before_rows = get_naim_rows()
print_rows(before_rows, f"{len(before_rows)} row(s) found")

# ── STEP 2: Reset to PENDING / ACTIVE ─────────────────────────────────────────
print()
print("=" * 60)
print("STEP 2 — Reset rows to status=PENDING, plan_status=ACTIVE")
print("=" * 60)
if not before_rows:
    print("  No rows to reset — will rely on n8n to create them.")
else:
    r = requests.patch(
        f"{SUPABASE_URL}/rest/v1/registrations_v1",
        headers=SB_WRITE,
        params={"artist_id": f"eq.{ARTIST_ID}"},
        json={"status": "PENDING", "plan_status": "ACTIVE",
              "n8n_execution_id": None, "external_id": None,
              "external_status": None, "last_error": None,
              "submitted_at": None},
    )
    if r.ok:
        updated = r.json()
        print(f"  Reset {len(updated)} row(s) — OK ({r.status_code})")
    else:
        print(f"  FAILED {r.status_code}: {r.text[:300]}")

# ── STEP 3: Trigger webhook ────────────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 3 — POST to registration-task webhook")
print("=" * 60)
payload = {"artist_id": ARTIST_ID}
print(f"  POST {N8N_WEBHOOK}")
print(f"  Body: {json.dumps(payload)}")
trig = requests.post(N8N_WEBHOOK,
                     headers={"Content-Type": "application/json"},
                     json=payload,
                     timeout=30)
print(f"  Response: {trig.status_code}")
try:
    print(f"  Body: {json.dumps(trig.json(), indent=2)}")
except Exception:
    print(f"  Body (raw): {trig.text[:500]}")

# ── STEP 4: Re-query after trigger ────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 4 — Re-query registrations_v1 (waiting 5s for n8n to process...)")
print("=" * 60)
time.sleep(5)
after_rows = get_naim_rows()
print_rows(after_rows, f"{len(after_rows)} row(s) found")

# Diff
print("\n  -- CHANGES vs before --")
before_map = {r["id"]: r for r in before_rows}
after_map  = {r["id"]: r for r in after_rows}
changed_any = False
for rid, arow in after_map.items():
    brow = before_map.get(rid, {})
    diffs = [(f, brow.get(f), arow[f]) for f in KEY_FIELDS
             if f in arow and arow[f] != brow.get(f)]
    if diffs:
        changed_any = True
        print(f"  row id={rid}:")
        for f, old, new in diffs:
            print(f"    {f:<22} {old!r}  →  {new!r}")
if not changed_any:
    print("  (no changes detected)")

# ── STEP 5: n8n executions ────────────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 5 — n8n: last 10 executions")
print("=" * 60)
wf_r   = requests.get(f"{N8N_BASE}/workflows", headers=N8N_H)
wf_map = {wf["id"]: wf["name"] for wf in wf_r.json().get("data", [])}

ex_r = requests.get(f"{N8N_BASE}/executions", headers=N8N_H, params={"limit": 10})
execs = ex_r.json().get("data", [])
for ex in execs:
    wf_name  = wf_map.get(ex.get("workflowId", ""), ex.get("workflowId", "?"))
    status   = ex.get("status", "?")
    started  = ex.get("startedAt", "?")
    finished = ex.get("stoppedAt", "?")
    ex_id    = ex.get("id", "?")
    flag = "  ✓" if status == "success" else "  ✗"
    print(f"{flag} [{ex_id}] {wf_name}")
    print(f"      status={status}  started={started}  finished={finished}")

# ── STEP 6: Report ────────────────────────────────────────────────────────────
print()
print("=" * 60)
print("STEP 6 — Summary")
print("=" * 60)
webhook_ok = trig.status_code in (200, 201, 202)
print(f"  Webhook trigger:  {'OK' if webhook_ok else 'FAILED'} ({trig.status_code})")

recent = execs[:3] if execs else []
successes = [e for e in recent if e.get("status") == "success"]
failures  = [e for e in recent if e.get("status") != "success"]
print(f"  Recent executions: {len(successes)} success, {len(failures)} failure")

if after_rows:
    for row in after_rows:
        s  = row.get("status", "?")
        ps = row.get("plan_status", "?")
        ex = row.get("n8n_execution_id")
        le = row.get("last_error")
        print(f"  Row {row.get('id','?')}: status={s}  plan_status={ps}  "
              f"n8n_execution_id={ex}  last_error={le}")

if failures:
    print("\n  FAILURES:")
    for e in failures:
        print(f"    [{e.get('id')}] {wf_map.get(e.get('workflowId',''), '?')} — {e.get('status')}")
