const h={'Content-Type':'application/json'};
export default async function handler(req,res){
  if(req.method!=='DELETE')return res.status(405).json({error:'Method not allowed'});
  try{
    const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    const userRes=await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});
    if(!userRes.ok)return res.status(401).json({error:'انتهت الجلسة، سجل الدخول مجددًا'});
    const user=await userRes.json();
    const adminRes=await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`,{method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,...h},body:'{}'});
    if(adminRes.ok&&(await adminRes.json())===true)return res.status(403).json({error:'لا يمكن حذف حساب المالك من الموقع. استخدم إعدادات الإدارة.'});
    const service={apikey:process.env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`,...h};
    const active=await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?user_id=eq.${user.id}&status=in.(paid,processing,packed,shipped)&select=id`,{headers:service});
    if((await active.json()).length)return res.status(409).json({error:'لا يمكن حذف الحساب قبل تسليم أو إغلاق الطلبات النشطة.'});
    const orders=await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?user_id=eq.${user.id}&select=id`,{headers:service});
    for(const order of await orders.json())await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`,{method:'PATCH',headers:service,body:JSON.stringify({user_id:null,customer_name:'عميل محذوف',customer_email:`deleted+${order.id}@invalid.ajlib.store`,customer_phone:'',shipping_address:''})});
    const deletion=await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`,{method:'DELETE',headers:service});
    if(!deletion.ok)return res.status(500).json({error:'تعذر حذف الحساب'});
    return res.status(200).json({deleted:true});
  }catch(e){return res.status(500).json({error:e.message||'تعذر حذف الحساب'})}
}
