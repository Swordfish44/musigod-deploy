import requests
import time
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

SUPABASE_URL = "https://uykzkrnoetcldeuxzqyy.supabase.co"
SUPABASE_SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
ARTIST_ID    = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"
N8N_WEBHOOK  = "https://musigod-n8n.onrender.com/webhook/registration-task"

SB_READ = {"apikey": SUPABASE_SVC, "Authorization": f"Bearer {SUPABASE_SVC}",
           "Accept-Profile": "registrations"}

# Get all PENDING rows
r = requests.get(f"{SUPABASE_URL}/rest/v1/registrations_v1", headers=SB_READ,
                 params={"artist_id": f"eq.{ARTIST_ID}", "status": "eq.PENDING",
                         "select": "id,action_url", "order": "created_at.asc"})
r.raise_for_status()
pending = r.json()
print(f"Found {len(pending)} PENDING rows — triggering each one...\n")

ok, failed = [], []
for i, row in enumerate(pending, 1):
    reg_id = row["id"]
    url    = row.get("action_url") or "(no action_url)"
    # Retry up to 3 times on connection errors
    last_exc = None
    resp = None
    for attempt in range(3):
        try:
            resp = requests.post(N8N_WEBHOOK,
                                 headers={"Content-Type": "application/json"},
                                 json={"registration_id": reg_id},
                                 timeout=20)
            last_exc = None
            break
        except Exception as e:
            last_exc = e
            time.sleep(2 ** attempt)  # 1s, 2s, 4s backoff

    if last_exc:
        status = f"FAIL(conn: {str(last_exc)[:60]})"
        print(f"  [{i:02d}/{len(pending)}] {reg_id}  {status}")
        failed.append((reg_id, "conn_err", str(last_exc)[:100]))
    else:
        status = "OK" if resp.status_code == 200 else f"FAIL({resp.status_code})"
        print(f"  [{i:02d}/{len(pending)}] {reg_id}  {status}  {url[:60]}")
        if resp.status_code == 200:
            ok.append(reg_id)
        else:
            failed.append((reg_id, resp.status_code, resp.text[:100]))
    time.sleep(1)   # 1s between triggers

print(f"\nDone. {len(ok)} triggered OK, {len(failed)} failed.")
if failed:
    print("\nFailed:")
    for reg_id, code, body in failed:
        print(f"  {reg_id}  HTTP {code}  {body}")
