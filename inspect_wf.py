import requests
import json
import sys
import io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")

H = {"X-N8N-API-KEY": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiI0YWMxNzFmYi0xMzZlLTQ2ZGEtOGU3My02MzhlYjQyYzlmMjAiLCJpc3MiOiJuOG4iLCJhdWQiOiJwdWJsaWMtYXBpIiwianRpIjoiYjljYjdlYjAtMTAwNS00N2JjLTlhNGEtODZjN2U2OGE2ZDU5IiwiaWF0IjoxNzc4NzI3OTgzLCJleHAiOjE3ODEyMzY4MDB9.A0k7EVpOJ9LqrNsvrjz9CRrYPE3nj4SvgY9iwHmjClA"}

r = requests.get("https://musigod-n8n.onrender.com/api/v1/workflows/c7ZomdY9n95PwLB9", headers=H)
wf = r.json()
for node in wf.get("nodes", []):
    name = node["name"]
    ntype = node["type"]
    params = node.get("parameters", {})
    print(f"=== {name} ({ntype}) ===")
    print(json.dumps(params, indent=2)[:1200])
    print()
