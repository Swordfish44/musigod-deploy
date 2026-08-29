'use strict'
const assert=require('assert'),fs=require('fs'),p=require('path').join(__dirname,'../supabase/migrations/20260829000000_rights_registration_center_v1.sql'),s=fs.readFileSync(p,'utf8')
for(const t of ['rights_registration_profiles_v1','rights_registration_items_v1','rights_identifiers_v1','rights_authorizations_v1','rights_registration_evidence_v1','rights_registration_reviews_v1','rights_registration_reminders_v1','rights_registration_audit_events_v1'])assert(s.includes(`registrations.${t}`),`${t} missing`)
assert(s.includes('ENABLE ROW LEVEL SECURITY'));assert(s.includes('REVOKE ALL'));assert(s.includes('audit events are append-only'));assert(s.includes('auth_user_id uuid UNIQUE'));assert(!s.includes('GRANT SELECT ON registrations.rights_registration_profiles_v1 TO anon'))
console.log('rights-registration-schema: RLS, ownership link, private pilot, and append-only audit controls pass')
