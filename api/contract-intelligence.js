'use strict'
const crypto=require('crypto');const {withSentry}=require('./_sentry');const {authenticate,sb}=require('./_registration-auth')
const SCHEMA='royalty_intelligence'
module.exports=withSentry(async function(req,res){
 res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'})
 if(!process.env.SUPABASE_SERVICE_ROLE_KEY&&!process.env.SUPABASE_SERVICE_KEY)return res.status(503).json({error:'Contract Intelligence database access is not configured'})
 const actor=await authenticate(req,{admin:true});if(!actor)return res.status(401).json({error:'Authenticated MusiGod session required'})
 try{
  const profile=await resolveProfile(actor,req.method==='POST'?req.body?.profile_id:req.query?.profile_id);if(!profile)return res.status(404).json({error:'No Rights Registration Center profile is linked to this account'})
  if(req.method==='GET')return res.status(200).json(await overview(profile))
  const b=req.body||{}
  if(b.action==='register_upload'){
   const kind=String(b.kind||'').toUpperCase();if(!['CONTRACT','STATEMENT'].includes(kind))return res.status(400).json({error:'kind must be CONTRACT or STATEMENT'})
   if(!/^[0-9a-f]{64}$/.test(String(b.sha256||'')))return res.status(400).json({error:'A lowercase SHA-256 source hash is required'})
   if(!String(b.object_path||'').startsWith(`${profile.id}/`))return res.status(400).json({error:'Private object path must be scoped to the profile'})
   const existing=await sb(`${kind==='CONTRACT'?'contract_documents_v1':'statement_imports_v1'}?profile_id=eq.${profile.id}&sha256=eq.${b.sha256}&limit=1`,{schema:SCHEMA});if(existing?.[0])return res.status(200).json({ok:true,id:existing[0].id,status:kind==='CONTRACT'?'PRESERVED':existing[0].status,idempotent:true})
   let row
   if(kind==='CONTRACT'){
    const byteSize=Number(b.byte_size);if(!Number.isSafeInteger(byteSize)||byteSize<=0)return res.status(400).json({error:'A positive integer byte_size is required'})
    const title=clean(b.title)||clean(b.file_name)||'Untitled contract',scope=String(b.asset_scope||'mixed').toLowerCase();let family=(await sb(`contract_families_v1?profile_id=eq.${profile.id}&title=eq.${encodeURIComponent(title)}&synthetic=eq.false&limit=1`,{schema:SCHEMA}))?.[0]
    if(!family)[family]=await sb('contract_families_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{profile_id:profile.id,title,asset_scope:['master','composition','mixed','other'].includes(scope)?scope:'mixed',synthetic:false}})
    const [contract]=await sb('contract_records_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{family_id:family.id,profile_id:profile.id,record_type:clean(b.record_type)||'other',title,execution_status:'UNSIGNED_DRAFT',version_label:clean(b.version_label)||'v1',authoritative:false,synthetic:false}})
    ;[row]=await sb('contract_documents_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{contract_id:contract.id,profile_id:profile.id,object_path:b.object_path,file_name:clean(b.file_name),media_type:clean(b.media_type)||'application/octet-stream',byte_size:byteSize,sha256:b.sha256,source_kind:'ORIGINAL',uploaded_by:actor.admin?null:actor.subject,synthetic:false}})
   }else{
    const payor=clean(b.payor);if(!payor)return res.status(400).json({error:'Statement payor is required'});let source=(await sb(`statement_sources_v1?profile_id=eq.${profile.id}&payor=eq.${encodeURIComponent(payor)}&source_type=eq.${encodeURIComponent(clean(b.source_type)||'OTHER')}&limit=1`,{schema:SCHEMA}))?.[0]
    if(!source)[source]=await sb('statement_sources_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{profile_id:profile.id,payor,source_type:clean(b.source_type)||'OTHER',recipient:clean(b.recipient)||null}})
    ;[row]=await sb('statement_imports_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{profile_id:profile.id,source_id:source.id,object_path:b.object_path,file_name:clean(b.file_name),media_type:clean(b.media_type)||'application/octet-stream',sha256:b.sha256,period_start:b.period_start||null,period_end:b.period_end||null,source_currency:String(b.source_currency||'USD').toUpperCase(),status:'QUARANTINED',synthetic:false}})
   }
   await audit(profile.id,actor,'source_upload.registered',kind.toLowerCase(),row.id,{kind,sha256:b.sha256,file_name:clean(b.file_name)})
   return res.status(202).json({ok:true,id:row.id,status:kind==='CONTRACT'?'PRESERVED':'QUARANTINED',message:'Source preserved for controlled validation; no terms or amounts are authoritative yet'})
  }
  if(b.action==='authorize_recovery'){
   if(!b.scope||!b.attested)return res.status(400).json({error:'Specific scope and affirmative attestation are required'})
   const [row]=await sb('authorization_records_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{profile_id:profile.id,scope:String(b.scope).slice(0,200),status:'PENDING_SIGNATURE',terms_version:'contract-intelligence-recovery-v1'}})
   await audit(profile.id,actor,'recovery_authorization.requested','authorization',row.id,{scope:row.scope});return res.status(200).json({ok:true,status:'PENDING_SIGNATURE',authorization_id:row.id})
  }
  if(b.action==='review_decision'){
   if(!actor.admin)return res.status(403).json({error:'Named administrative reviewer required'})
   const rows=await sb(`review_tasks_v1?id=eq.${encodeURIComponent(b.task_id)}&profile_id=eq.${profile.id}&limit=1`,{schema:SCHEMA});const task=rows?.[0]
   if(!task)return res.status(404).json({error:'Review task not found'});if(!['APPROVED','REJECTED','LEGAL_REVIEW','RESOLVED'].includes(b.status))return res.status(400).json({error:'Invalid review decision'})
   if(String(b.notes||'').trim().length<12)return res.status(400).json({error:'Reviewer resolution notes must contain at least 12 characters'})
   const now=new Date().toISOString();await sb(`review_tasks_v1?id=eq.${task.id}`,{schema:SCHEMA,method:'PATCH',body:{status:b.status,assigned_reviewer:String(b.reviewer_name||actor.subject).slice(0,120),reviewer_role:String(b.reviewer_role||'ADMINISTRATOR').slice(0,60),decision:b.status,resolution_notes:String(b.notes).trim().slice(0,4000),decided_at:now}})
   await audit(profile.id,actor,'review.decided','review_task',task.id,{status:b.status,reviewer:b.reviewer_name||actor.subject});return res.status(200).json({ok:true})
  }
  return res.status(400).json({error:'Unknown action'})
 }catch(error){console.error('contract-intelligence',error);return res.status(500).json({error:'Contract Intelligence request failed'})}
},'contract-intelligence')
async function resolveProfile(actor,requested){if(actor.admin&&requested){return (await sb(`rights_registration_profiles_v1?id=eq.${encodeURIComponent(requested)}&limit=1`))?.[0]}return (await sb(`rights_registration_profiles_v1?auth_user_id=eq.${encodeURIComponent(actor.subject)}&limit=1`))?.[0]}
async function overview(profile){const q=(table,tail='')=>sb(`${table}?profile_id=eq.${profile.id}${tail}`,{schema:SCHEMA});const [families,contracts,terms,imports,runs,results,discrepancies,cases,windows,tasks]=await Promise.all([q('contract_families_v1','&order=created_at.desc'),q('contract_records_v1','&order=created_at.desc'),q('extracted_terms_v1','&order=created_at.desc'),q('statement_imports_v1','&order=imported_at.desc'),q('calculation_runs_v1','&order=created_at.desc'),q('reconciliation_results_v1','&order=created_at.desc'),q('discrepancies_v1','&order=created_at.desc'),q('recovery_cases_v1','&order=created_at.desc'),q('audit_windows_v1','&order=due_date.asc'),q('review_tasks_v1','&status=in.(OPEN,IN_REVIEW,LEGAL_REVIEW)&order=created_at.asc')]);return {profile:{id:profile.id,artist_name:profile.artist_name,legal_name:profile.legal_name},contracts:{families,records:contracts},terms,statement_imports:imports,calculation_runs:runs,reconciliations:results,discrepancies,recovery_cases:cases,audit_windows:windows,review_tasks:tasks,disclosure:'MusiGod is not a law firm and does not provide legal advice. Calculated expectations and potential discrepancies are not money owed or recovered.'}}
async function audit(profileId,actor,event,entityType,entityId,payload){const previous=await sb(`audit_events_v1?profile_id=eq.${profileId}&order=created_at.desc&limit=1`,{schema:SCHEMA});const prior=previous?.[0]?.event_hash||null,created_at=new Date().toISOString(),payload_hash=hash(payload),event_hash=hash({profileId,event,entityType,entityId,payload_hash,prior,created_at});await sb('audit_events_v1',{schema:SCHEMA,method:'POST',body:{profile_id:profileId,event_type:event,actor_type:actor.admin?'ADMIN':'CLIENT',actor_subject:actor.subject,entity_type:entityType,entity_id:entityId,payload,payload_hash,previous_event_hash:prior,event_hash,created_at}})}
function hash(v){return crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex')}function clean(v){return String(v||'').trim().slice(0,240)}
