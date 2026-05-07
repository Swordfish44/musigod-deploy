f = open("C:/musigod-deploy/admin.html", encoding="utf-8").read()

# Fix the duplicate error variable in activateOne
old = """async function activateOne(id, name){
  if(!confirm("Activate " + name + "?")) return;
  const {error} = await sb.schema("registrations").from("registrations_v1")
    .update({status:"ACTIVE"})
    .eq("id", id);
  if(error){showToast("Error: "+error.message,"err")}
  else{showToast(name+" ACTIVE","ok");setTimeout(()=>loadAll(),800)}
  return;"""

new = """async function activateOne(id, name){
  if(!confirm("Activate " + name + "?")) return;
  const {error: actErr} = await sb.schema("registrations").from("registrations_v1")
    .update({status:"ACTIVE"})
    .eq("id", id);
  if(actErr){showToast("Error: "+actErr.message,"err");return;}
  showToast(name+" ACTIVE","ok");setTimeout(()=>loadAll(),800);return;"""

f2 = f.replace(old, new, 1)
if f == f2:
    print("NOT FOUND")
else:
    open("C:/musigod-deploy/admin.html","w",encoding="utf-8").write(f2)
    print("Done")
