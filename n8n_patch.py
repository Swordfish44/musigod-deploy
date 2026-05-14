import requests
import json
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

# ── CONFIG ───────────────────────────────────────────────────────────────────
N8N_BASE = "https://musigod-n8n.onrender.com/api/v1"
N8N_API_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YWMxNzFmYi0xMzZlLTQ2ZGEtOGU3My02MzhlYjQyYzlmMjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYjljYjdlYjAtMTAwNS00N2JjLTlhNGEtODZjN2U2OGE2ZDU5IiwiaWF0IjoxNzc4NzI3OTgzLCJleHAiOjE3ODEyMzY4MDB9.A0k7EVpOJ9LqrNsvrjz9CRrYPE3nj4SvgY9iwHmjClA"

OLD_HOST = "musigod.app.n8n.cloud"
NEW_HOST = "musigod-n8n.onrender.com"

HEADERS = {
    "X-N8N-API-KEY": N8N_API_KEY,
    "Content-Type": "application/json",
}

# ── HELPERS ──────────────────────────────────────────────────────────────────
def patch_value(v):
    if isinstance(v, str) and OLD_HOST in v:
        return v.replace(OLD_HOST, NEW_HOST)
    return v

def patch_obj(obj):
    """Recursively replace OLD_HOST in any string inside a dict/list."""
    if isinstance(obj, str):
        return obj.replace(OLD_HOST, NEW_HOST) if OLD_HOST in obj else obj
    if isinstance(obj, dict):
        return {k: patch_obj(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [patch_obj(i) for i in obj]
    return obj

def patch_node(node):
    if node.get("type") != "n8n-nodes-base.httpRequest":
        return node, False
    original = json.dumps(node)
    patched = patch_obj(node)
    changed = json.dumps(patched) != original
    return patched, changed

# ── STEP 1: GET all workflows ─────────────────────────────────────────────────
print("=" * 60)
print("STEP 1 — Fetching all workflows")
r = requests.get(f"{N8N_BASE}/workflows", headers=HEADERS)
print(f"  Status: {r.status_code}")
r.raise_for_status()
workflows = r.json().get("data", [])
print(f"  Found {len(workflows)} workflows")
for wf in workflows:
    print(f"  [{wf['id']}] {wf['name']}  active={wf['active']}")

# ── STEP 2 + 3: Patch & PUT each workflow ─────────────────────────────────────
print("\nSTEP 2+3 — Patching httpRequest nodes & uploading")
patched_ids = []
for wf in workflows:
    wf_id = wf["id"]
    full_r = requests.get(f"{N8N_BASE}/workflows/{wf_id}", headers=HEADERS)
    full_r.raise_for_status()
    data = full_r.json()

    nodes = data.get("nodes", [])
    wf_changed = False
    for i, node in enumerate(nodes):
        nodes[i], changed = patch_node(node)
        if changed:
            print(f"  [{wf_id}] {wf['name']} — patched node: {node.get('name')} ({node.get('type')})")
            wf_changed = True

    if not wf_changed:
        print(f"  [{wf_id}] {wf['name']} — no changes needed")
        continue

    data["nodes"] = nodes
    # Strip server-managed fields; filter settings to API-allowed keys only
    SETTINGS_ALLOWED = {
        "timezone", "saveDataErrorExecution", "saveDataSuccessExecution",
        "saveManualExecutions", "saveExecutionProgress", "executionTimeout",
        "errorWorkflow", "callerPolicy", "callerIds",
    }
    raw_settings = data.get("settings", {})
    clean_settings = {k: v for k, v in raw_settings.items() if k in SETTINGS_ALLOWED}
    put_body = {k: v for k, v in data.items()
                if k in ("name", "nodes", "connections", "staticData", "pinData")}
    put_body["settings"] = clean_settings
    put_r = requests.put(
        f"{N8N_BASE}/workflows/{wf_id}",
        headers=HEADERS,
        json=put_body,
    )
    if put_r.ok:
        print(f"  [{wf_id}] PUT OK ({put_r.status_code})")
        patched_ids.append(wf_id)
    else:
        print(f"  [{wf_id}] PUT FAILED {put_r.status_code}: {put_r.text[:300]}")

# ── STEP 4: Activate ALL workflows ────────────────────────────────────────────
print("\nSTEP 4 — Activating all workflows")
for wf in workflows:
    wf_id = wf["id"]
    act_r = requests.post(
        f"{N8N_BASE}/workflows/{wf_id}/activate",
        headers=HEADERS,
    )
    if act_r.ok:
        print(f"  [{wf_id}] {wf['name']} — activated OK ({act_r.status_code})")
    else:
        print(f"  [{wf_id}] {wf['name']} — FAILED {act_r.status_code}: {act_r.text[:200]}")

# ── STEP 5: Verify ────────────────────────────────────────────────────────────
print("\nSTEP 5 — Verifying")
all_ok = True
for wf in workflows:
    wf_id = wf["id"]
    v = requests.get(f"{N8N_BASE}/workflows/{wf_id}", headers=HEADERS)
    v.raise_for_status()
    d = v.json()
    active = d.get("active", False)
    nodes = d.get("nodes", [])

    cred_issues = []
    for node in nodes:
        ntype = node.get("type", "")
        if "resend" in ntype.lower() or "supabase" in ntype.lower():
            creds = node.get("credentials")
            if not creds:
                cred_issues.append(f"{node.get('name')} ({ntype})")

    status = "OK" if active and not cred_issues else "PROBLEM"
    if status != "OK":
        all_ok = False
    print(f"  [{wf_id}] {d.get('name')}")
    print(f"    active={active}  cred_issues={cred_issues if cred_issues else 'none'}  [{status}]")

print()
print("=" * 60)
print("RESULT:", "ALL GOOD" if all_ok else "SOME ISSUES — see above")
