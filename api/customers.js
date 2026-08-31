const jsonHeaders = { 'Content-Type': 'application/json' };
const serviceHeaders = () => ({ apikey: process.env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${process.env.SUPABASE_SECRET_KEY}`, ...jsonHeaders });
const db = (path, options={}) => fetch(`${process.env.SUPABASE_URL}${path}`, { ...options, headers: { ...serviceHeaders(), ...(options.headers||{}) } });
const isAdmin = async auth => {
  const token=String(auth||'').replace(/^Bearer\s+/i,''); if(!token)return false;
  const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`,{method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,...jsonHeaders},body:'{}'});
  return r.ok&&(await r.json())===true;
};
export default async function handler(req,res){
  try{
    if(!(await isAdmin(req.headers.authorization)))return res.status(403).json({error:'هذه العملية متاحة لمالك AJLIB فقط'});
    if(req.method==='GET'){
      const usersRes=await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users?per_page=1000`,{headers:serviceHeaders()});
      if(!usersRes.ok){const detail=await usersRes.text();return res.status(502).json({error:'تعذر تحميل حسابات العملاء',detail:detail.slice(0,300)})}
      const users=(await usersRes.json()).users||[];
      const profilesRes=await db('/rest/v1/profiles?select=id,full_name,phone,emirate,city,address,delivery_notes,role');
      if(!profilesRes.ok){const detail=await profilesRes.text();return res.status(502).json({error:'تعذر تحميل بيانات العملاء',detail:detail.slice(0,300)})}
      const profileRows=await profilesRes.json();
      const profiles=new Map((Array.isArray(profileRows)?profileRows:[]).map(p=>[p.id,p]));
      const ordersRes=await db('/rest/v1/orders?select=user_id,customer_email,status,amount_total');
      if(!ordersRes.ok){const detail=await ordersRes.text();return res.status(502).json({error:'تعذر تحميل ملخص طلبات العملاء',detail:detail.slice(0,300)})}
      const orderRows=await ordersRes.json(),orders=Array.isArray(orderRows)?orderRows:[];
      return res.status(200).json(users.map(u=>{const p=profiles.get(u.id)||{},own=orders.filter(o=>o.user_id===u.id||String(o.customer_email||'').toLowerCase()===String(u.email||'').toLowerCase());return{id:u.id,email:u.email,created_at:u.created_at,last_sign_in_at:u.last_sign_in_at,...p,orders_count:own.length,total_spent:own.filter(o=>!['cancelled','refunded'].includes(o.status)).reduce((s,o)=>s+Number(o.amount_total||0),0)}}));
    }
    const body=req.body||{},id=String(body.id||''); if(!id)return res.status(400).json({error:'معرّف العميل مطلوب'});
    if(req.method==='PATCH'){
      const profile={full_name:String(body.full_name||'').trim(),phone:String(body.phone||'').trim(),emirate:String(body.emirate||'').trim(),city:String(body.city||'').trim(),address:String(body.address||'').trim(),delivery_notes:String(body.delivery_notes||'').trim()};
      const p=await db(`/rest/v1/profiles?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify(profile)});
      if(!p.ok)return res.status(502).json({error:'تعذر حفظ بيانات العميل'});
      return res.status(200).json((await p.json())[0]||profile);
    }
    if(req.method==='DELETE'){
      const active=await db(`/rest/v1/orders?user_id=eq.${encodeURIComponent(id)}&status=in.(paid,processing,packed,shipped)&select=id`);
      if((await active.json()).length)return res.status(409).json({error:'لا يمكن حذف عميل لديه طلب نشط. أغلق أو سلّم الطلب أولًا.'});
      const userRes=await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`,{headers:serviceHeaders()});
      if(!userRes.ok)return res.status(404).json({error:'العميل غير موجود'});
      const user=await userRes.json();
      await db(`/rest/v1/orders?user_id=eq.${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({user_id:null,customer_name:'عميل محذوف',customer_email:`deleted+${id}@invalid.ajlib.store`,customer_phone:'',shipping_address:''})});
      const deletion=await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${encodeURIComponent(id)}`,{method:'DELETE',headers:serviceHeaders()});
      if(!deletion.ok)return res.status(502).json({error:'تعذر حذف حساب العميل'});
      return res.status(200).json({deleted:true,email:user.email});
    }
    return res.status(405).json({error:'Method not allowed'});
  }catch(e){return res.status(500).json({error:e.message||'تعذر إدارة العملاء'})}
}
