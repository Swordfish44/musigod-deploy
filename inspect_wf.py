import os
import requests
import json
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

H = {"X-N8N-API-KEY": os.environ["N8N_API_KEY"]}

r = requests.get("https://musigod-n8n.onrender.com/api/v1/workflows/c7ZomdY9n95PwLB9", headers=H)
wf = r.json()
for node in wf.get("nodes", []):
    name = node["name"]
    ntype = node["type"]
    params = node.get("parameters", {})
    print(f"=== {name} ({ntype}) ===")
    print(json.dumps(params, indent=2)[:1200])
    print()
