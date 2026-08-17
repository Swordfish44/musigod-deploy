'use strict';
const assert=require('assert'),crypto=require('crypto'),fs=require('fs'),path=require('path'),pilot=require('../lib/harbourview-workspace');
let passed=0;function test(name,fn){try{fn();console.log(`  ✅ ${name}`);passed++}catch(error){console.error(`  ❌ ${name}: ${error.message}`);process.exitCode=1}}
console.log('=== HarbourView Pilot Workspace Tests ===');
test('catalog input is normalized and starts in intake',()=>{const r=pilot.validateCatalog({catalog_code:'hv-test-1',name:'Controlled Sample',asset_type:'mixed'});assert.equal(r.catalog_code,'HV-TEST-1');assert.equal(r.status,'intake')});
test('chain-of-title cannot be assigned to an analyst',()=>assert.throws(()=>pilot.validateReviewTask({task_type:'chain_of_title',title:'Review title',required_reviewer_role:'analyst'}),/requires reviewer/));
test('legal chain-of-title review task is accepted',()=>assert.equal(pilot.validateReviewTask({task_type:'chain_of_title',title:'Review title',required_reviewer_role:'legal'}).status,'open'));
test('authorized import plan preserves provenance',()=>{const p=pilot.buildImportPlan({manifest:{source_name:'HarbourView authorized portfolio export',transport:'csv',content_sha256:crypto.createHash('sha256').update('pilot').digest('hex')},record_type:'recording',records:[{title:' Test ',isrc:'US-ABC-12-12345'}]},{organization_id:'11111111-1111-1111-1111-111111111111',imported_at:'2026-08-17T00:00:00Z'});assert.equal(p.records[0].normalized_payload.title,'Test');assert.equal(p.records[0].provenance.source_name,'HarbourView authorized portfolio export')});
test('empty imports are rejected',()=>assert.throws(()=>pilot.buildImportPlan({records:[]},{}),/at least one/));
test('pilot import row cap is enforced',()=>assert.throws(()=>pilot.buildImportPlan({records:Array.from({length:pilot.MAX_IMPORT_ROWS+1},()=>({title:'x'}))},{}),/limited/));
const migration=fs.readFileSync(path.join(__dirname,'../supabase/migrations/20260817000000_harbourview_pilot_workspace_v1.sql'),'utf8');
test('five pilot tables are created',()=>assert.equal((migration.match(/CREATE TABLE IF NOT EXISTS public\.enterprise_(pilot_workspaces|catalogs|assets|review_tasks|activity_events)_v1/g)||[]).length,5));
test('pilot tables receive organization-scoped reads',()=>assert(migration.includes('fn_enterprise_has_org_access(organization_id)')));
test('activity history is immutable',()=>assert(migration.includes('enterprise activity events are append-only')));
test('HarbourView seed is idempotent',()=>assert(migration.includes('ON CONFLICT (slug) DO UPDATE')&&migration.includes('ON CONFLICT (organization_id, workspace_code) DO UPDATE')));
test('external submissions and legal automation are disabled',()=>assert(migration.includes("'external_submission_enabled', false")&&migration.includes("'legal_determination_automation', false")));
test('resolved tasks require a named resolver',()=>assert(migration.includes("status NOT IN ('approved','rejected','closed') OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)")));
if(!process.exitCode)console.log(`\n=== Results: ${passed} passed, 0 failed ===`);
