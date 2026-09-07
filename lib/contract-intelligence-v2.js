'use strict';
const crypto=require('crypto');
const ENGINE_VERSION='contract-intelligence-v2.0.0';
const RULES=[
 ['royalty_rate',/\b(royalt(?:y|ies)|rate)\b/i],['ownership',/\b(own(?:er|ership|s)|title|copyright)\b/i],['term',/\b(term|commencement|duration|initial period)\b/i],
 ['territory',/\b(territor(?:y|ies)|worldwide|universe)\b/i],['audit_rights',/\b(audit|inspect.*books|examine.*records)\b/i],['accounting',/\b(accounting|statements?|render.*account)\b/i],
 ['reserve',/\b(reserve|holdback)\b/i],['recoupment',/\b(recoup|recoupable|unrecouped)\b/i],['deduction',/\b(deduct|distribution fee|packaging|breakage)\b/i],
 ['termination',/\b(terminat|breach|cure period)\b/i],['reversion',/\b(revert|reversion)\b/i],['assignment',/\b(assign|assignment|successors)\b/i],['option',/\boption period|renewal option\b/i]
];
function stable(v){if(v===null||typeof v!=='object')return JSON.stringify(v);if(Array.isArray(v))return `[${v.map(stable).join(',')}]`;return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`}
function sha(v){return crypto.createHash('sha256').update(typeof v==='string'?v:stable(v)).digest('hex')}
function normalize(type,text){const percent=text.match(/(\d+(?:\.\d+)?)\s*%/),days=text.match(/(\d+)\s*(?:business\s+)?days?/i),years=text.match(/(\d+)\s*years?/i),date=text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);const value={raw:text};if(percent)value.percent=Number(percent[1]);if(days)value.days=Number(days[1]);if(years)value.years=Number(years[1]);if(date)value.date=date[1];if(type==='territory')value.scope=/worldwide|universe/i.test(text)?'WORLDWIDE':'SPECIFIED';return value}
function extractClauses({document_id,contract_id,profile_id,pages,source_sha256}){
 if(!document_id||!contract_id||!profile_id||!Array.isArray(pages)||!pages.length)throw new Error('document, contract, profile and pages are required');if(!/^[a-f0-9]{64}$/.test(source_sha256||''))throw new Error('valid source SHA-256 is required');
 const clauses=[];
 for(const page of pages){
  if(!Number.isInteger(page.page_number)||page.page_number<1)throw new Error('positive page_number required');
  const paragraphs=String(page.text||'').split(/\n{2,}|(?<=\.)\s+(?=[A-Z])/).map(x=>x.trim()).filter(x=>x.length>=12);
  paragraphs.forEach((text,i)=>{
   const hit=RULES.find(([,rx])=>rx.test(text));if(!hit)return;
   const explicit=/%|\$|\b\d+\s*(?:days?|years?)|worldwide|universe/i.test(text);
   clauses.push({document_id,contract_id,profile_id,clause_type:hit[0],page_number:page.page_number,paragraph_reference:`p${page.page_number}.${i+1}`,clause_reference:null,original_text:text,original_text_hash:sha(text),extraction_method:'DETERMINISTIC_RULES_V2',model_version:ENGINE_VERSION,confidence:explicit ? 0.93 : 0.78,review_required:true,term:{term_key:hit[0],normalized_value:normalize(hit[0],text),interpretation:`Candidate ${hit[0].replaceAll('_',' ')} term. Human review required before calculation or legal reliance.`,authority_basis:explicit?'EXPLICIT':'INFERRED',confidence:explicit ? 0.93 : 0.78,status:'PENDING_REVIEW',calculation_authoritative:false,territory:/worldwide|universe/i.test(text)?'WORLDWIDE':null,exploitation_type:null},source:{document_id,page_number:page.page_number,paragraph_reference:`p${page.page_number}.${i+1}`,source_sha256}});
  });
 }
 return {engine_version:ENGINE_VERSION,input_hash:sha({document_id,source_sha256,pages}),clauses,summary:{pages:pages.length,candidates:clauses.length,explicit:clauses.filter(x=>x.term.authority_basis==='EXPLICIT').length,inferred:clauses.filter(x=>x.term.authority_basis==='INFERRED').length},legal_conclusion:false,external_action_enabled:false};
}
function detectConflicts(terms){const conflicts=[];for(let i=0;i<terms.length;i++)for(let j=i+1;j<terms.length;j++){const a=terms[i],b=terms[j];if(a.term_key!==b.term_key)continue;if(stable(a.normalized_value)===stable(b.normalized_value))continue;conflicts.push({term_key:a.term_key,term_a_id:a.id||null,term_b_id:b.id||null,classification:'CONTRADICTORY_TERMS',status:'LEGAL_REVIEW',explanation:`Conflicting ${a.term_key.replaceAll('_',' ')} terms require precedence and legal review.`,evidence:[a.source||{},b.source||{}]})}return conflicts}
function approveTerm(term,reviewer,notes){if(!reviewer?.name||!['ADMINISTRATOR','LEGAL'].includes(reviewer.role))throw new Error('Named administrator or legal reviewer required');if(String(notes||'').trim().length<12)throw new Error('Substantive review notes required');if(term.authority_basis!=='EXPLICIT')return {...term,status:'LEGAL_REVIEW',calculation_authoritative:false};return {...term,status:'APPROVED',calculation_authoritative:true,reviewed_by:reviewer.name,reviewer_role:reviewer.role,review_notes:notes.trim()}}
module.exports={ENGINE_VERSION,RULES,stable,sha,normalize,extractClauses,detectConflicts,approveTerm};
