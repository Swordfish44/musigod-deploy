"""
Patches index.html and admin.html to wire up affiliates ref tracking.

index.html:  signup POST now includes ref_code from ?ref= URL param
admin.html:  activateOne() now calls fn_create_commission RPC after activation
"""
import re, sys

def patch_index():
    path = "index.html"
    with open(path, encoding="utf-8") as f:
        src = f.read()

    OLD = """      body: JSON.stringify({
        legal_first_name: first,
        legal_last_name:  last,
        artist_name:      artist,
        email:            email,
        country:          country,
        plan_status:      'ACTIVE'
      })"""

    NEW = """      body: (() => {
        const _ref = new URLSearchParams(window.location.search).get('ref');
        const _payload = {
          legal_first_name: first,
          legal_last_name:  last,
          artist_name:      artist,
          email:            email,
          country:          country,
          plan_status:      'ACTIVE'
        };
        if (_ref) _payload.ref_code = _ref;
        return JSON.stringify(_payload);
      })()"""

    if OLD not in src:
        print(f"  [SKIP] index.html: target block not found — already patched or source changed")
        return False
    patched = src.replace(OLD, NEW, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(patched)
    print("  [OK]   index.html: ref_code capture added to signup POST")
    return True


def patch_admin():
    path = "admin.html"
    with open(path, encoding="utf-8") as f:
        src = f.read()

    OLD = """async function activateOne(id, name){
  if(!confirm("Activate " + name + "?")) return;
  const res = await fetch(SUPABASE_URL+'/rest/v1/registrations_v1?id=eq.'+id, {method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_SERVICE,'Authorization':'Bearer '+SUPABASE_SERVICE,'Accept-Profile':'registrations','Content-Profile':'registrations'},body:JSON.stringify({status:'ACTIVE'})});
  if(!res.ok){const t=await res.text();showToast('Error: '+t,'err');return;}
  showToast(name+' ACTIVE','ok');setTimeout(()=>loadAll(),800)
}"""

    NEW = """async function activateOne(id, name){
  if(!confirm("Activate " + name + "?")) return;
  const res = await fetch(SUPABASE_URL+'/rest/v1/registrations_v1?id=eq.'+id, {method:'PATCH',headers:{'Content-Type':'application/json','apikey':SUPABASE_SERVICE,'Authorization':'Bearer '+SUPABASE_SERVICE,'Accept-Profile':'registrations','Content-Profile':'registrations'},body:JSON.stringify({status:'ACTIVE'})});
  if(!res.ok){const t=await res.text();showToast('Error: '+t,'err');return;}
  showToast(name+' ACTIVE','ok');
  // Commission wiring: look up artist ref_code → call fn_create_commission RPC
  try {
    const _reg = allRegs.find(r=>r.registration_id===id);
    if(_reg?.artist_id){
      const _artR = await fetch(SUPABASE_URL+'/rest/v1/artists_v1?id=eq.'+_reg.artist_id+'&select=ref_code',{
        headers:{'apikey':SUPABASE_SERVICE,'Authorization':'Bearer '+SUPABASE_SERVICE,'Accept-Profile':'artists'}
      });
      if(_artR.ok){
        const [_art]=await _artR.json();
        if(_art?.ref_code){
          const _commR = await fetch(SUPABASE_URL+'/rest/v1/rpc/fn_create_commission',{
            method:'POST',
            headers:{'Content-Type':'application/json','apikey':SUPABASE_SERVICE,'Authorization':'Bearer '+SUPABASE_SERVICE},
            body:JSON.stringify({p_affiliate_code:_art.ref_code,p_artist_id:_reg.artist_id,p_trigger:'activation'})
          });
          const _commJ = await _commR.json().catch(()=>({}));
          console.log('[commission]',_commJ);
        }
      }
    }
  } catch(_e){console.warn('[commission error]',_e)}
  setTimeout(()=>loadAll(),800)
}"""

    if OLD not in src:
        print(f"  [SKIP] admin.html: activateOne block not found — already patched or source changed")
        return False
    patched = src.replace(OLD, NEW, 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(patched)
    print("  [OK]   admin.html: commission creation wired into activateOne()")
    return True


print("=== patch_affiliates.py ===")
r1 = patch_index()
r2 = patch_admin()

if not r1 and not r2:
    print("\nNothing changed — both files already patched or targets not found.")
    sys.exit(0)

print("\nVerifying patches...")

# Verify index.html
with open("index.html", encoding="utf-8") as f:
    idx = f.read()
assert "URLSearchParams(window.location.search).get('ref')" in idx, "index.html patch missing!"
assert "ref_code" in idx, "index.html ref_code missing!"
print("  [OK] index.html verified")

# Verify admin.html
with open("admin.html", encoding="utf-8") as f:
    adm = f.read()
assert "fn_create_commission" in adm, "admin.html commission RPC missing!"
assert "ref_code" in adm, "admin.html ref_code lookup missing!"
print("  [OK] admin.html verified")

print("\nAll patches applied. Next steps:")
print("  1. Run the SQL migration in Supabase SQL editor:")
print("     supabase/migrations/20260515_affiliates_wiring.sql")
print("  2. vercel --prod --force")
