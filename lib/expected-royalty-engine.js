'use strict'
const crypto=require('crypto')
const ENGINE_VERSION='expected-royalty-v1.0.0'
const CLASSIFICATIONS=new Set(['MATCHED_WITHIN_TOLERANCE','MISSING_ESCALATION','UNSUPPORTED_DEDUCTION','STALE_RESERVE','UNMATCHED_RECORDING','CURRENCY_CONVERSION_DISCREPANCY','BLOCKED_MISSING_CONTRACT_LANGUAGE','FORMAL_AUDIT_CANDIDATE'])
function integer(value,label){if(typeof value==='bigint')return value;if(typeof value==='number'&&Number.isSafeInteger(value))return BigInt(value);if(typeof value==='string'&&/^-?\d+$/.test(value))return BigInt(value);throw new Error(`${label} must be an integer minor-unit value`)}
function ratio(value,label){if(!value||value.numerator==null||value.denominator==null)throw new Error(`${label} requires numerator and denominator`);const n=integer(value.numerator,`${label}.numerator`),d=integer(value.denominator,`${label}.denominator`);if(d<=0n)throw new Error(`${label}.denominator must be positive`);return {n,d}}
function mulRatio(amount,r){const negative=(amount<0n)!==(r.n<0n),a=amount<0n?-amount:amount,n=r.n<0n?-r.n:r.n;const q=a*n/r.d,rem=a*n%r.d,rounded=rem*2n>=r.d?q+1n:q;return negative?-rounded:rounded}
function sha(value){return crypto.createHash('sha256').update(stable(value)).digest('hex')}
function stable(value){if(value===null||typeof value!=='object')return JSON.stringify(value);if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`}
function assertScope(input){const contract=String(input.contract_asset_scope||'').toUpperCase(),line=String(input.statement_asset_scope||'').toUpperCase();if(!['MASTER','COMPOSITION'].includes(contract)||!['MASTER','COMPOSITION'].includes(line))return;if(contract!==line)throw new Error(`asset scope mismatch: ${contract} terms cannot calculate ${line} royalties`)}
function calculateLine(input){
 assertScope(input);const required=['royalty_base_minor','rate','reported_minor','source_currency','reporting_currency'];for(const key of required)if(input[key]==null)return blocked(input,`Missing calculation-authoritative contract language: ${key}`)
 if(input.term_authority!=='EXPLICIT'||input.term_review_status!=='APPROVED')return blocked(input,'Royalty term is not explicit and approved by a named reviewer')
 const base=integer(input.royalty_base_minor,'royalty_base_minor'),rate=ratio(input.rate,'rate'),reported=integer(input.reported_minor,'reported_minor')
 const gross=mulRatio(base,rate),contractual=Array.isArray(input.contractual_deductions)?input.contractual_deductions.reduce((n,v)=>n+integer(v.amount_minor,'deduction'),0n):0n
 const reserve=integer(input.reserve_minor||0,'reserve_minor'),recoupment=integer(input.recoupment_minor||0,'recoupment_minor'),withholding=integer(input.withholding_minor||0,'withholding_minor')
 const expectedSource=gross-contractual-reserve-recoupment-withholding
 const fx=input.source_currency===input.reporting_currency?{n:1n,d:1n}:ratio(input.fx_rate,'fx_rate')
 const expected=mulRatio(expectedSource,fx),reportedNormalized=mulRatio(reported,fx),variance=expected-reportedNormalized,tolerance=integer(input.tolerance_minor||1,'tolerance_minor')
 let classification=input.classification_hint||((variance<0n?-variance:variance)<=tolerance?'MATCHED_WITHIN_TOLERANCE':'FORMAL_AUDIT_CANDIDATE')
 if(!CLASSIFICATIONS.has(classification))throw new Error('unsupported classification')
 const result={engine_version:ENGINE_VERSION,status:'COMPLETED',classification,expected_gross_minor:gross.toString(),expected_net_minor:expected.toString(),reported_minor:reportedNormalized.toString(),variance_minor:variance.toString(),source_currency:input.source_currency,reporting_currency:input.reporting_currency,fx_rate_numerator:fx.n.toString(),fx_rate_denominator:fx.d.toString(),amount_basis:classification==='MATCHED_WITHIN_TOLERANCE'?'CALCULATED_EXPECTATION':'ESTIMATED_OPPORTUNITY',confidence:String(input.confidence||'0.80'),assumptions:input.assumptions||[],evidence:input.evidence||[],legal_conclusion:false,external_action_enabled:false}
 return {...result,result_hash:sha(result)}
}
function blocked(input,reason){const result={engine_version:ENGINE_VERSION,status:'BLOCKED',classification:'BLOCKED_MISSING_CONTRACT_LANGUAGE',blocked_reasons:[reason],source_currency:input.source_currency||null,reporting_currency:input.reporting_currency||null,amount_basis:'NO_CALCULATION',legal_conclusion:false,external_action_enabled:false};return {...result,result_hash:sha(result)}}
function reconcile(lines){const fingerprints=new Set();return lines.map(line=>{const fingerprint=sha(line);if(fingerprints.has(fingerprint))return {...blocked(line,'Duplicate input line'),classification:'DUPLICATE_LINE'};fingerprints.add(fingerprint);return calculateLine(line)})}
module.exports={ENGINE_VERSION,CLASSIFICATIONS,integer,ratio,mulRatio,sha,stable,calculateLine,reconcile}
