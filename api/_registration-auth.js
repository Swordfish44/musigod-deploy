'use strict'
const SB_URL=process.env.SUPABASE_URL||'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY=process.env.SUPABASE_SERVICE_ROLE_KEY||process.env.SUPABASE_SERVICE_KEY
function bearer(req){ const h=String(req.headers.authorization||''); return h.startsWith('Bearer ')?h.slice(7):'' }
async function authenticate(req,{admin=false}={}){
  // Admin mode is intentionally fail-closed. A normal Supabase user session is
  // not sufficient for an admin-only endpoint unless a separate admin-role
  // system is explicitly introduced. For now, admin access requires the
  // dedicated X-Admin-Key secret.
  if(admin){
    if(process.env.ADMIN_API_KEY && req.headers['x-admin-key']===process.env.ADMIN_API_KEY){
      return {admin:true,subject:'admin'}
    }
    return null
  }

  const token=bearer(req); if(!token) return null
  const r=await fetch(`${SB_URL}/auth/v1/user`,{headers:{apikey:SB_KEY,Authorization:`Bearer ${token}`}})
  if(!r.ok)return null; const u=await r.json(); return {admin:false,subject:u.id,email:u.email}
}
function headers(schema='registrations',extra={}){return {apikey:SB_KEY,Authorization:`Bearer ${SB_KEY}`,'Accept-Profile':schema,'Content-Profile':schema,'Content-Type':'application/json',...extra}}
async function sb(path,{schema='registrations',method='GET',body,prefer}={}){const r=await fetch(`${SB_URL}/rest/v1/${path}`,{method,headers:headers(schema,prefer?{Prefer:prefer}:{}),body:body===undefined?undefined:JSON.stringify(body)});const t=await r.text();if(!r.ok)throw new Error(`database ${r.status}: ${t.slice(0,240)}`);return t?JSON.parse(t):null}
module.exports={SB_URL,SB_KEY,authenticate,headers,sb}
