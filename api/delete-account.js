import crypto from 'node:crypto';

const h={'Content-Type':'application/json'};
const serviceHeaders=()=>({apikey:process.env.SUPABASE_SECRET_KEY,Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`,...h});

async function authenticatedUser(req){
  const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
  const response=await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`,{headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`}});
  if(!response.ok)return null;
  return response.json();
}

async function isAdmin(token){
  const response=await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`,{method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,...h},body:'{}'});
  return response.ok&&(await response.json())===true;
}

async function hasActiveOrders(userId){
  const response=await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?user_id=eq.${encodeURIComponent(userId)}&status=in.(paid,processing,packed,shipped)&select=id`,{headers:serviceHeaders()});
  const rows=await response.json();
  return Array.isArray(rows)&&rows.length>0;
}

function deletionCode(user,bucket=Math.floor(Date.now()/600000)){
  const digest=crypto.createHmac('sha256',process.env.SUPABASE_SECRET_KEY).update(`${user.id}:${String(user.email).toLowerCase()}:${bucket}:AJLIB-DELETE`).digest('hex');
  return String(parseInt(digest.slice(0,10),16)%1000000).padStart(6,'0');
}

async function sendCode(user,code){
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${process.env.RESEND_API_KEY}`,...h},body:JSON.stringify({
    from:process.env.ORDER_FROM_EMAIL||'AJLIB Accounts <accounts@ajlib.store>',
    to:[user.email],
    subject:'رمز تأكيد حذف حساب AJLIB',
    html:`<div dir="rtl" style="font-family:Arial,sans-serif;line-height:1.8;color:#26352d"><h2>تأكيد حذف حساب AJLIB</h2><p>استخدم الرمز التالي لتأكيد حذف حسابك:</p><p style="font-size:30px;font-weight:800;letter-spacing:8px">${code}</p><p>الرمز صالح لمدة 10 دقائق. إذا لم تطلب حذف الحساب فتجاهل هذه الرسالة ولن يحدث أي تغيير.</p></div>`
  })});
  if(!response.ok)throw new Error('تعذر إرسال رمز التأكيد إلى البريد');
}

export default async function handler(req,res){
  if(!['POST','DELETE'].includes(req.method))return res.status(405).json({error:'Method not allowed'});
  try{
    if(!process.env.RESEND_API_KEY||!process.env.SUPABASE_SECRET_KEY)return res.status(503).json({error:'خدمة تأكيد الحذف غير متاحة الآن'});
    const token=String(req.headers.authorization||'').replace(/^Bearer\s+/i,''),user=await authenticatedUser(req);
    if(!user)return res.status(401).json({error:'انتهت الجلسة، سجل الدخول مجددًا'});
    if(await isAdmin(token))return res.status(403).json({error:'لا يمكن حذف حساب المالك من الموقع. استخدم إعدادات الإدارة.'});
    if(await hasActiveOrders(user.id))return res.status(409).json({error:'لا يمكن حذف الحساب قبل تسليم أو إغلاق الطلبات النشطة.'});

    if(req.method==='POST'){
      await sendCode(user,deletionCode(user));
      return res.status(200).json({sent:true,email:String(user.email).replace(/^(.{2}).*(@.*)$/,'$1***$2')});
    }

    const submitted=String(req.body?.code||'').trim(),valid=[deletionCode(user),deletionCode(user,Math.floor(Date.now()/600000)-1)].includes(submitted);
    if(!/^\d{6}$/.test(submitted)||!valid)return res.status(400).json({error:'رمز التأكيد غير صحيح أو انتهت صلاحيته'});
    const service=serviceHeaders(),orders=await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?user_id=eq.${user.id}&select=id`,{headers:service});
    for(const order of await orders.json())await fetch(`${process.env.SUPABASE_URL}/rest/v1/orders?id=eq.${order.id}`,{method:'PATCH',headers:service,body:JSON.stringify({user_id:null,customer_name:'عميل محذوف',customer_email:`deleted+${order.id}@invalid.ajlib.store`,customer_phone:'',shipping_address:''})});
    const deletion=await fetch(`${process.env.SUPABASE_URL}/auth/v1/admin/users/${user.id}`,{method:'DELETE',headers:service});
    if(!deletion.ok)return res.status(500).json({error:'تعذر حذف الحساب'});
    return res.status(200).json({deleted:true});
  }catch(e){return res.status(500).json({error:e.message||'تعذر حذف الحساب'})}
}
