"""
Attempts to run the affiliates migration via Supabase Management API.
Falls back to instructions if the management API token is unavailable.
"""
import urllib.request, urllib.error, json, os, sys

SB_REF = "uykzkrnoetcldeuxzqyy"
SVC    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"

with open("supabase/migrations/20260515_affiliates_wiring.sql", encoding="utf-8") as f:
    SQL = f.read()

def try_mgmt_api(token):
    url = f"https://api.supabase.com/v1/projects/{SB_REF}/database/query"
    req = urllib.request.Request(
        url,
        data=json.dumps({"query": SQL}).encode(),
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")

# Try SUPABASE_ACCESS_TOKEN env var (personal access token)
pat = os.environ.get("SUPABASE_ACCESS_TOKEN") or os.environ.get("SUPABASE_PAT")
if pat:
    print(f"Trying Management API with SUPABASE_ACCESS_TOKEN...")
    code, resp = try_mgmt_api(pat)
    print(f"  {code}: {resp}")
    sys.exit(0 if code == 200 else 1)

# Try with service role key (won't work — management API needs PAT, not service key)
print("Trying Management API with service role key (expected to fail)...")
code, resp = try_mgmt_api(SVC)
print(f"  {code}: {str(resp)[:200]}")

if code != 200:
    print("""
Management API requires a Personal Access Token (PAT), not the service role key.

TO RUN THE MIGRATION MANUALLY:
  1. Open: https://supabase.com/dashboard/project/uykzkrnoetcldeuxzqyy/sql/new
  2. Paste the contents of: supabase/migrations/20260515_affiliates_wiring.sql
  3. Click Run

OR — provide your Supabase PAT:
  $env:SUPABASE_ACCESS_TOKEN = "sbp_xxxx..."
  python run_migration.py
""")
    sys.exit(1)
