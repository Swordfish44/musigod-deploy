'use strict'
const crypto=require('crypto')
const SUPPORTED=new Map([['csv','CSV'],['tsv','TSV'],['txt','DELIMITED_TEXT'],['json','JSON'],['jsonl','JSONL'],['xml','XML'],['xlsx','XLSX'],['xls','XLS'],['xlsb','XLSB'],['pdf','PDF'],['zip','ZIP'],['gz','GZIP']])
function classify(name,head=Buffer.alloc(0)){
 const ext=String(name).toLowerCase().split('.').pop(),magic=head.subarray(0,8).toString('hex')
 if(magic.startsWith('4d5a'))return {format_key:'EXECUTABLE',supported:false,blocked:true,reason:'DOS/Windows executable signature'}
 if(magic.startsWith('504b0304'))return {format_key:ext==='xlsx'?'XLSX':'ZIP',supported:true,archive:true}
 if(magic.startsWith('25504446'))return {format_key:'PDF',supported:true}
 if(magic.startsWith('1f8b'))return {format_key:'GZIP',supported:true,archive:true}
 const format=SUPPORTED.get(ext)||'UNKNOWN';return {format_key:format,supported:['CSV','TSV','DELIMITED_TEXT','JSON','JSONL','XML'].includes(format),requires_specialized_worker:['XLSX','XLS','XLSB','PDF','ZIP','GZIP'].includes(format)}
}
function detectDelimiter(sample){const lines=String(sample).split(/\r?\n/).filter(Boolean).slice(0,10),candidates=[',','\t',';','|'];let best=',',score=-1;for(const d of candidates){const counts=lines.map(x=>countOutsideQuotes(x,d));const stable=counts.length&&counts.every(x=>x===counts[0])?1000:0,n=counts.reduce((a,b)=>a+b,0)+stable;if(n>score){score=n;best=d}}return best}
function countOutsideQuotes(line,d){let q=false,n=0;for(let i=0;i<line.length;i++){if(line[i]==='"'){if(q&&line[i+1]==='"')i++;else q=!q}else if(!q&&line[i]===d)n++}return n}
async function* parseDelimited(stream,{delimiter=',',startRow=0}={}){
 const decoder=new TextDecoder('utf-8',{fatal:false}),reader=stream.getReader();let field='',row=[],quoted=false,rowNo=0,pending=''
 for(;;){const {done,value}=await reader.read();pending+=decoder.decode(value||new Uint8Array(),{stream:!done});let i=0
  while(i<pending.length){const c=pending[i];if(c==='"'){if(quoted&&pending[i+1]==='"'){field+='"';i+=2;continue}quoted=!quoted;i++;continue}
   if(!quoted&&c===delimiter){row.push(field);field='';i++;continue}
   if(!quoted&&(c==='\n'||c==='\r')){if(c==='\r'&&pending[i+1]==='\n')i++;row.push(field);field='';rowNo++;if(rowNo>startRow)yield {row_number:rowNo,values:row};row=[];i++;continue}
   field+=c;i++}
  pending='';if(done)break
 }
 if(field.length||row.length){row.push(field);rowNo++;if(rowNo>startRow)yield {row_number:rowNo,values:row}}
}
function normalizeHeader(values){const seen=new Map();return values.map((v,i)=>{let key=String(v||`column_${i+1}`).trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'')||`column_${i+1}`;const n=(seen.get(key)||0)+1;seen.set(key,n);return n===1?key:`${key}_${n}`})}
function rowObject(headers,values){const out={};for(let i=0;i<Math.max(headers.length,values.length);i++)out[headers[i]||`unknown_column_${i+1}`]=values[i]??null;return out}
function fingerprint(v){return crypto.createHash('sha256').update(typeof v==='string'?v:stable(v)).digest('hex')}
function stable(v){if(Array.isArray(v))return `[${v.map(stable).join(',')}]`;if(v&&typeof v==='object')return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;return JSON.stringify(v)}
function parseExactDecimal(value,scale=2){const s=String(value??'').trim().replace(/[$£€¥,\s]/g,'');if(!s)return null;if(!/^-?\d+(\.\d+)?$/.test(s))throw new Error('INVALID_DECIMAL');const neg=s[0]==='-',p=(neg?s.slice(1):s).split('.'),fraction=(p[1]||'').padEnd(scale,'0');if(fraction.length>scale&&!/^0*$/.test(fraction.slice(scale)))throw new Error('PRECISION_EXCEEDS_MINOR_UNIT_SCALE');const n=BigInt(p[0]||'0')*(10n**BigInt(scale))+BigInt(fraction.slice(0,scale)||'0');return (neg?-n:n).toString()}
module.exports={classify,detectDelimiter,parseDelimited,normalizeHeader,rowObject,fingerprint,parseExactDecimal}
