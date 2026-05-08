import re

with open('admin.html', 'r', encoding='utf-8') as f:
    content = f.read()

old = 'const {error: actErr} = await sb.schema("registrations").from("registrations_v1")\n    .update({status:"ACTIVE"})\n    .eq("id", id);\n  if(actErr){showToast("Error: "+actErr.message,"err");return;}\n  showToast(name+" ACTIVE","ok");setTimeout(()=>loadAll(),800);return;'

new = 'const res = await fetch(SUPABASE_URL+\'/rest/v1/registrations_v1?id=eq.\'+id, {method:\'PATCH\',headers:{\'Content-Type\':\'application/json\',\'apikey\':SUPABASE_ANON,\'Authorization\':\'Bearer \'+SUPABASE_ANON,\'Accept-Profile\':\'registrations\',\'Content-Profile\':\'registrations\'},body:JSON.stringify({status:\'ACTIVE\'})});\n  if(!res.ok){const t=await res.text();showToast(\'Error: \'+t,\'err\');return;}\n  showToast(name+\' ACTIVE\',\'ok\');setTimeout(()=>loadAll(),800);return;'

if old in content:
    content = content.replace(old, new, 1)
    with open('admin.html', 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)
    print('Fixed')
else:
    print('NOT FOUND')
