'use strict'
// Synthetic, non-authoritative, testing only; never live evidence or a legal conclusion.
const fs=require('fs'),path=require('path'),out=process.argv[2]||path.join(process.cwd(),'tmp','one-million-row.synthetic.csv'),rows=Number(process.argv[3]||1000000)
fs.mkdirSync(path.dirname(out),{recursive:true});const s=fs.createWriteStream(out);s.write('asset_type,title,artist,isrc,territory,service,usage_type,units,net_royalty,currency\n');let i=0
function write(){let ok=true;while(i<rows&&ok){i++;ok=s.write(`MASTER,Synthetic Track ${i%1000},Synthetic Artist,USTST${String(i%10000000).padStart(7,'0')},US,Example DSP,STREAM,1,0.01,USD\n`)}if(i<rows)s.once('drain',write);else s.end()}write();s.on('finish',()=>console.log(JSON.stringify({synthetic:true,authoritative:false,rows,path:out})))
