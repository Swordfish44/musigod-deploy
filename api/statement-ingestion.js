'use strict'
const crypto=require('crypto');const {withSentry}=require('./_sentry');const {SB_URL,authenticate,sb}=require('./_registration-auth')
const SCHEMA='royalty_intelligence',BUCKET='artist-documents',MAX=5*1024*1024*1024
module.exports=withSentry(async function(req,res){
 res.setHeader('Cache-Control','no-store');if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'Method not allowed'})
 const actor=await authenticate(req,{admin:true});if(!actor)return res.status(401).json({error:'Authenticated MusiGod session required'})
 try{const profile=await resolveProfile(actor,req.method==='POST'?req.body?.profile_id:req.query?.profile_id);if(!profile)return res.status(404).json({error:'Rights profile not found'})
  if(req.method==='GET')return res.status(200).json(await overview(profile.id,actor.admin))
  const b=req.body||{},action=String(b.action||'')
  if(action==='init_upload'){
   const name=fileName(b.file_name),size=Number(b.byte_size),media=String(b.media_type||'application/octet-stream').slice(0,160)
   if(!name||!Number.isSafeInteger(size)||size<1||size>MAX)return res.status(400).json({error:'A valid file name and byte size up to 5 GB are required'})
   if(isExecutable(name,media))return res.status(400).json({error:'Executable uploads are prohibited'})
   const [pkg]=await sb('statement_packages_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{profile_id:profile.id,title:String(b.package_title||name).slice(0,240),period_start:b.period_start||null,period_end:b.period_end||null,created_by:actor.admin?null:actor.subject}})
   const id=crypto.randomUUID(),objectPath=`royalty-statements/${profile.id}/${pkg.id}/${id}-${name}`,expires=new Date(Date.now()+60*60*1000).toISOString()
   const [session]=await sb('upload_sessions_v1',{schema:SCHEMA,method:'POST',prefer:'return=representation',body:{id,profile_id:profile.id,package_id:pkg.id,bucket:BUCKET,object_path:objectPath,original_name:name,declared_media_type:media,declared_size:size,status:'UPLOADING',upload_protocol:'TUS',expires_at:expires,created_by:actor.admin?null:actor.subject}})
   await audit(profile.id,actor,'statement_upload.initiated','upload_session',session.id,{package_id:pkg.id,file_name:name,declared_size:size})
   return res.status(201).json({ok:true,package_id:pkg.id,upload_session_id:session.id,protocol:'tus',endpoint:`${SB_URL}/storage/v1/upload/resumable`,bucket:BUCKET,object_path:objectPath,expires_at:expires,max_bytes:MAX,requirements:{chunk_bytes:6291456,upsert:false,private:true}})
  }
  if(action==='complete_upload'){
   const session=(await sb(`upload_sessions_v1?id=eq.${encodeURIComponent(b.upload_session_id)}&profile_id=eq.${profile.id}&limit=1`,{schema:SCHEMA}))?.[0]
   if(!session)return res.status(404).json({error:'Upload session not found'});if(session.status==='CANCELLED')return res.status(409).json({error:'Upload session was cancelled'})
   await sb(`upload_sessions_v1?id=eq.${session.id}`,{schema:SCHEMA,method:'PATCH',body:{status:'UPLOADED',completed_at:new Date().toISOString()}})
   const key=hash(`VERIFY:${session.id}:${session.object_path}`);let [job]=await sb('ingestion_jobs_v1',{schema:SCHEMA,method:'POST',prefer:'resolution=ignore-duplicates,return=representation',body:{profile_id:profile.id,package_id:session.package_id,job_type:'VERIFY_HASH_CLASSIFY',idempotency_key:key}});if(!job)job=(await sb(`ingestion_jobs_v1?idempotency_key=eq.${key}&limit=1`,{schema:SCHEMA}))?.[0]
   await sb(`statement_packages_v1?id=eq.${session.package_id}`,{schema:SCHEMA,method:'PATCH',body:{status:'QUARANTINED'}});await audit(profile.id,actor,'statement_upload.completed','upload_session',session.id,{job_id:job.id})
   return res.status(202).json({ok:true,package_id:session.package_id,job_id:job.id,status:'QUARANTINED',message:'Original source is preserved; validation and hashing are queued.'})
  }
  if(action==='cancel'){
   const pkg=(await sb(`statement_packages_v1?id=eq.${encodeURIComponent(b.package_id)}&profile_id=eq.${profile.id}&limit=1`,{schema:SCHEMA}))?.[0];if(!pkg)return res.status(404).json({error:'Package not found'})
   await Promise.all([sb(`statement_packages_v1?id=eq.${pkg.id}`,{schema:SCHEMA,method:'PATCH',body:{status:'CANCELLED'}}),sb(`ingestion_jobs_v1?package_id=eq.${pkg.id}&status=in.(QUEUED,RETRY,REVIEW_REQUIRED)`,{schema:SCHEMA,method:'PATCH',body:{status:'CANCELLED',updated_at:new Date().toISOString()}})])
   await audit(profile.id,actor,'statement_package.cancelled','statement_package',pkg.id,{});return res.status(200).json({ok:true,status:'CANCELLED'})
  }
  if(action==='release_quarantine'){
   if(!actor.admin)return res.status(403).json({error:'Named administrative reviewer required'});const reviewer=String(b.reviewer_name||'').trim(),notes=String(b.notes||'').trim()
   if(reviewer.length<2||notes.length<12)return res.status(400).json({error:'Named reviewer and substantive scan/release notes are required'})
   const file=(await sb(`source_files_v1?id=eq.${encodeURIComponent(b.source_file_id)}&profile_id=eq.${profile.id}&limit=1`,{schema:SCHEMA}))?.[0];if(!file)return res.status(404).json({error:'Source file not found'})
   if(b.malware_status!=='CLEAN')return res.status(400).json({error:'A clean malware-scan attestation is required to release quarantine'})
   await sb(`source_files_v1?id=eq.${file.id}`,{schema:SCHEMA,method:'PATCH',body:{malware_status:'CLEAN',quarantine_status:'RELEASED'}})
   await sb(`import_exceptions_v1?source_file_id=eq.${file.id}&rule_key=eq.MALWARE_SCAN_ATTESTATION_REQUIRED&review_status=eq.OPEN`,{schema:SCHEMA,method:'PATCH',body:{review_status:'RESOLVED',named_reviewer:reviewer,resolution_notes:notes,resolved_at:new Date().toISOString()}})
   const jobs={CSV:'STREAM_DELIMITED',TSV:'STREAM_DELIMITED',DELIMITED_TEXT:'STREAM_DELIMITED',XLSX:'STREAM_XLSX',PDF:'EXTRACT_PDF',ZIP:'EXPAND_ZIP'},jobType=jobs[file.format_key],supported=!!jobType,key=hash(`PARSE:${file.sha256}:${jobType||'unsupported'}:v1`);let job=null
   if(supported){[job]=await sb('ingestion_jobs_v1',{schema:SCHEMA,method:'POST',prefer:'resolution=ignore-duplicates,return=representation',body:{profile_id:profile.id,package_id:file.package_id,source_file_id:file.id,job_type:jobType,idempotency_key:key}});if(!job)job=(await sb(`ingestion_jobs_v1?idempotency_key=eq.${key}&limit=1`,{schema:SCHEMA}))?.[0]}
   await sb(`statement_packages_v1?id=eq.${file.package_id}`,{schema:SCHEMA,method:'PATCH',body:{status:supported?'PROCESSING':'REVIEW_REQUIRED'}});await audit(profile.id,actor,'statement_quarantine.released','source_file',file.id,{reviewer,scan_status:'CLEAN',next_job_id:job?.id||null})
   return res.status(200).json({ok:true,status:supported?'PROCESSING':'SPECIALIZED_WORKER_REQUIRED',job_id:job?.id||null})
  }
  if(action==='approve_import'){
   if(!actor.admin)return res.status(403).json({error:'Named administrative reviewer required'});const reviewer=String(b.reviewer_name||'').trim(),notes=String(b.notes||'').trim();if(reviewer.length<2||notes.length<12)return res.status(400).json({error:'Named reviewer and resolution notes are required'})
   const pkg=(await sb(`statement_packages_v1?id=eq.${encodeURIComponent(b.package_id)}&profile_id=eq.${profile.id}&limit=1`,{schema:SCHEMA}))?.[0];if(!pkg)return res.status(404).json({error:'Package not found'})
   const blockers=await sb(`import_exceptions_v1?package_id=eq.${pkg.id}&severity=eq.BLOCKING&review_status=in.(OPEN,IN_REVIEW,LEGAL_REVIEW)&select=id`,{schema:SCHEMA});if(blockers.length)return res.status(409).json({error:'Open blocking exceptions prevent import approval',blocking_count:blockers.length})
   const sources=await sb(`source_files_v1?package_id=eq.${pkg.id}&select=id`,{schema:SCHEMA});if(!sources.length)return res.status(409).json({error:'No preserved source file is available for approval'});const rows=await sb(`raw_source_rows_v1?profile_id=eq.${profile.id}&source_file_id=in.(${sources.map(x=>x.id).join(',')})&select=id`,{schema:SCHEMA})
   const [approval]=await sb('import_approvals_v1',{schema:SCHEMA,method:'POST',prefer:'resolution=merge-duplicates,return=representation',body:{profile_id:profile.id,package_id:pkg.id,status:'APPROVED',named_reviewer:reviewer,reviewer_role:String(b.reviewer_role||'ROYALTY_ADMINISTRATOR').slice(0,80),resolution_notes:notes,approved_line_count:rows.length}})
   await sb(`statement_packages_v1?id=eq.${pkg.id}`,{schema:SCHEMA,method:'PATCH',body:{status:'APPROVED'}});await audit(profile.id,actor,'statement_import.approved','statement_package',pkg.id,{approval_id:approval.id,approved_line_count:rows.length,reviewer});return res.status(200).json({ok:true,status:'APPROVED',approval_id:approval.id,expected_royalty_handoff:'READY_FOR_EXPLICIT_CALCULATION_REQUEST'})
  }
  return res.status(400).json({error:'Unknown action'})
 }catch(e){console.error('statement-ingestion',e);return res.status(500).json({error:'Statement ingestion request failed'})}
},'statement-ingestion')
async function resolveProfile(actor,id){if(actor.admin&&id)return (await sb(`rights_registration_profiles_v1?id=eq.${encodeURIComponent(id)}&limit=1`))?.[0];return (await sb(`rights_registration_profiles_v1?auth_user_id=eq.${encodeURIComponent(actor.subject)}&limit=1`))?.[0]}
async function overview(profileId,admin){const q=(t,s='')=>sb(`${t}?profile_id=eq.${profileId}${s}`,{schema:SCHEMA});const [packages,jobs,files,exceptions,approvals,adapters]=await Promise.all([q('statement_packages_v1','&order=created_at.desc&limit=50'),q('ingestion_jobs_v1','&order=created_at.desc&limit=100'),q('source_files_v1','&order=created_at.desc&limit=100'),q('import_exceptions_v1','&review_status=in.(OPEN,IN_REVIEW,LEGAL_REVIEW)&order=created_at.asc&limit=200'),q('import_approvals_v1','&order=approved_at.desc&limit=50'),sb('adapter_versions_v1?approval_status=in.(TESTED,APPROVED)&order=adapter_key',{schema:SCHEMA})]);return {packages,jobs:admin?jobs:jobs.map(({lease_owner,last_error_safe,...x})=>x),files,exceptions,approvals,adapters,capacity:{maximum_declared_file_bytes:MAX,demonstrated_fixture_rows:1000000,ten_million_rows:'projected_not_yet_certified'},disclosure:'Reported statement data is not independently verified. Calculated variances are not money owed, claimed, settled, or recovered.'}}
async function audit(profileId,actor,event,entityType,entityId,payload){const prior=(await sb(`audit_events_v1?profile_id=eq.${profileId}&order=created_at.desc&limit=1`,{schema:SCHEMA}))?.[0]?.event_hash||null,created_at=new Date().toISOString(),payload_hash=hash(JSON.stringify(payload)),event_hash=hash(JSON.stringify({profileId,event,entityType,entityId,payload_hash,prior,created_at}));await sb('audit_events_v1',{schema:SCHEMA,method:'POST',body:{profile_id:profileId,event_type:event,actor_type:actor.admin?'ADMIN':'CLIENT',actor_subject:actor.subject,entity_type:entityType,entity_id:entityId,payload,payload_hash,previous_event_hash:prior,event_hash,created_at}})}
function fileName(v){return String(v||'').replace(/[^a-zA-Z0-9._ ()-]/g,'_').slice(0,180)}function hash(v){return crypto.createHash('sha256').update(v).digest('hex')}function isExecutable(n,m){return /\.(exe|dll|msi|com|bat|cmd|ps1|sh|scr|jar|app)$/i.test(n)||/x-msdownload|x-executable/.test(m)}
