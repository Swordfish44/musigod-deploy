"""Check current state: ref_code column, fn_create_commission, fn_get_commissions, affiliates schema."""
import urllib.request, urllib.error, json

SB  = "https://uykzkrnoetcldeuxzqyy.supabase.co"
SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
ARTIST_ID = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"

def sb(method, path, schema, body=None):
    url = f"{SB}/rest/v1/{path}"
    hdrs = {"apikey": SVC, "Authorization": f"Bearer {SVC}",
            "Accept-Profile": schema, "Content-Profile": schema}
    if body is not None: hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, headers=hdrs, method=method)
    if body is not None: req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read()
            try: return r.status, json.loads(raw)
            except: return r.status, raw.decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")

results = {}

# 1. ref_code column on artists_v1
code, data = sb("GET", f"artists_v1?id=eq.{ARTIST_ID}&select=ref_code", "artists")
results["ref_code_col"] = "OK" if (code == 200 and isinstance(data, list) and data and "ref_code" in data[0]) else f"MISSING ({code}): {str(data)[:100]}"

# 2. affiliates schema accessible
code, data = sb("GET", "affiliates_v1?select=*&limit=1", "affiliates")
results["affiliates_schema"] = f"OK ({len(data) if isinstance(data,list) else '?'} rows)" if code == 200 else f"FAIL ({code}): {str(data)[:100]}"

# 3. fn_create_commission (probe with empty code — should return ok=false, not 404)
code, data = sb("POST", "rpc/fn_create_commission", "public",
                body={"p_affiliate_code": "", "p_artist_id": ARTIST_ID, "p_trigger": "probe"})
if code == 200:   results["fn_create_commission"] = f"OK: {data}"
elif code == 404: results["fn_create_commission"] = "NOT FOUND (404) — migration not applied"
else:             results["fn_create_commission"] = f"FAIL ({code}): {str(data)[:100]}"

# 4. fn_get_commissions
code, data = sb("POST", "rpc/fn_get_commissions", "public", body={"p_artist_id": ARTIST_ID})
if code == 200:   results["fn_get_commissions"] = f"OK: {str(data)[:80]}"
elif code == 404: results["fn_get_commissions"] = "NOT FOUND (404) — migration not applied"
else:             results["fn_get_commissions"] = f"FAIL ({code}): {str(data)[:100]}"

print("\nCurrent state:")
for k, v in results.items():
    print(f"  {k:30s} {v}")
