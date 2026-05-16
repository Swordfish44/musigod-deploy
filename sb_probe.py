import urllib.request, urllib.error, json, sys

SB  = "https://uykzkrnoetcldeuxzqyy.supabase.co"
ANO = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc1MzA2MTksImV4cCI6MjA5MzEwNjYxOX0.r4Dx_Jkgje2kYNGh9PQtuyuJgBGJwVAviHM9QmAJcrs"
SVC = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk"
ARTIST_ID = "3d4788b6-2a86-4ed5-8f27-ab95b3a230d3"

def req(method, path, schema, key, body=None):
    url = f"{SB}/rest/v1/{path}"
    hdrs = {"apikey": key, "Authorization": f"Bearer {key}",
            "Accept-Profile": schema, "Content-Profile": schema}
    if body is not None:
        hdrs["Content-Type"] = "application/json"
    r = urllib.request.Request(url, headers=hdrs, method=method)
    if body is not None:
        r.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(r) as resp:
            raw = resp.read()
            try: data = json.loads(raw)
            except: data = raw.decode()
            return resp.status, data
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")

def chk(label, path, schema, key):
    code, data = req("GET", path, schema, key)
    if code == 200 and isinstance(data, list):
        cols = list(data[0].keys()) if data else []
        print(f"  OK  {code}  {label}  rows={len(data)}  cols={cols}")
    elif code == 200:
        print(f"  OK  {code}  {label}  (non-list response)")
    else:
        snippet = str(data)[:200].replace("\n"," ")
        print(f" FAIL {code}  {label}  => {snippet}")
    return code, data

print("\n== 1. SCHEMA ACCESS (anon key) ==")
chk("artists.artists_v1",            "artists_v1?select=id,artist_name&limit=3",  "artists",       ANO)
chk("registrations.registrations_v1","registrations_v1?select=id&limit=3",        "registrations", ANO)
chk("affiliates.affiliates_v1",      "affiliates_v1?select=*&limit=3",            "affiliates",    ANO)
chk("affiliates.commissions_v1",     "commissions_v1?select=*&limit=3",           "affiliates",    ANO)

print("\n== 2. SCHEMA ACCESS (service key) ==")
chk("artists.artists_v1",            "artists_v1?select=id,artist_name&limit=3",  "artists",       SVC)
chk("registrations.registrations_v1","registrations_v1?select=id&limit=3",        "registrations", SVC)
chk("affiliates.affiliates_v1",      "affiliates_v1?select=*&limit=3",            "affiliates",    SVC)
chk("affiliates.commissions_v1",     "commissions_v1?select=*&limit=3",           "affiliates",    SVC)

print("\n== 3. ARTIST ROW ==")
code, data = req("GET", f"artists_v1?id=eq.{ARTIST_ID}&select=*", "artists", SVC)
if code == 200 and isinstance(data, list):
    if data:
        a = data[0]
        print(f"  artist: {a.get('artist_name')} / {a.get('email')} / status={a.get('plan_status')}")
        print(f"  cols: {list(a.keys())}")
        # check for ref_code column
        print(f"  ref_code col present: {'ref_code' in a}")
    else:
        print(f"  no row found for artist_id={ARTIST_ID}")
else:
    print(f"  FAIL {code}: {str(data)[:200]}")

print("\n== 4. AFFILIATES TABLE COLUMNS ==")
for tbl in ["affiliates_v1", "commissions_v1"]:
    code, data = req("GET", f"{tbl}?select=*&limit=1", "affiliates", SVC)
    if code == 200 and isinstance(data, list):
        cols = list(data[0].keys()) if data else []
        print(f"  {tbl}: rows={len(data)}, cols={cols if cols else '(empty table — HEAD to get schema)'}")
    else:
        print(f"  {tbl} FAIL {code}: {str(data)[:200]}")

# Try HEAD to get column info even for empty tables
print("\n== 5. AFFILIATES COLUMNS VIA HEAD ==")
for tbl in ["affiliates_v1", "commissions_v1"]:
    url = f"{SB}/rest/v1/{tbl}?select=*&limit=0"
    hdrs = {"apikey": SVC, "Authorization": f"Bearer {SVC}",
            "Accept-Profile": "affiliates", "Content-Profile": "affiliates",
            "Accept": "application/json"}
    r = urllib.request.Request(url, headers=hdrs, method="GET")
    try:
        with urllib.request.urlopen(r) as resp:
            data = json.loads(resp.read())
            # With limit=0 PostgREST returns empty array
            # Get column info from content-range or just note it's accessible
            print(f"  {tbl}: accessible (empty result = limit=0 worked)")
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"  {tbl} FAIL {e.code}: {body[:200]}")

print("\n== 6. RLS POLICIES CHECK ==")
# Try information_schema approach
code, data = req("GET",
    "tables?table_schema=in.(artists,affiliates,registrations)&select=table_schema,table_name,table_type",
    "information_schema", SVC)
if code == 200 and isinstance(data, list):
    for row in data:
        print(f"  {row.get('table_schema')}.{row.get('table_name')} ({row.get('table_type')})")
else:
    print(f"  info_schema FAIL {code}: {str(data)[:200]}")

# Try pg_policies via pg_catalog schema (may not be exposed)
code, data = req("GET",
    "pg_policies?schemaname=in.(artists,affiliates,registrations)&select=schemaname,tablename,policyname,cmd,roles",
    "pg_catalog", SVC)
if code == 200 and isinstance(data, list):
    if data:
        for p in data:
            print(f"  POLICY {p.get('schemaname')}.{p.get('tablename')}: {p.get('policyname')} ({p.get('cmd')}) roles={p.get('roles')}")
    else:
        print("  pg_policies: accessible but 0 rows returned")
else:
    print(f"  pg_catalog.pg_policies FAIL {code}: {str(data)[:200]}")
