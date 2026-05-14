import requests
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

HEADERS = {"X-N8N-API-KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YWMxNzFmYi0xMzZlLTQ2ZGEtOGU3My02MzhlYjQyYzlmMjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYjljYjdlYjAtMTAwNS00N2JjLTlhNGEtODZjN2U2OGE2ZDU5IiwiaWF0IjoxNzc4NzI3OTgzLCJleHAiOjE3ODEyMzY4MDB9.A0k7EVpOJ9LqrNsvrjz9CRrYPE3nj4SvgY9iwHmjClA"}
BASE = "https://musigod-n8n.onrender.com/api/v1"

r = requests.get(f"{BASE}/workflows", headers=HEADERS)
workflows = r.json().get("data", [])

print(f"{'ID':<20} {'Name':<36} {'Active':<8} Cred Issues")
print("-" * 85)

all_ok = True
for wf in workflows:
    wf_id = wf["id"]
    d = requests.get(f"{BASE}/workflows/{wf_id}", headers=HEADERS).json()
    active = d.get("active", False)
    nodes = d.get("nodes", [])
    cred_issues = [
        node.get("name")
        for node in nodes
        if ("resend" in node.get("type", "").lower() or "supabase" in node.get("type", "").lower())
        and not node.get("credentials")
    ]
    status = "OK" if active and not cred_issues else "PROBLEM"
    if status != "OK":
        all_ok = False
    cred_str = ", ".join(cred_issues) if cred_issues else "none"
    print(f"{wf_id:<20} {d.get('name'):<36} {str(active):<8} {cred_str}  [{status}]")

print()
print("FINAL RESULT:", "ALL GOOD" if all_ok else "ISSUES REMAIN")
