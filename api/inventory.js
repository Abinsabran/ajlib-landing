const headers = { 'Content-Type': 'application/json' };
const db = (path, options={}) => fetch(`${process.env.SUPABASE_URL}${path}`, { ...options, headers: { apikey:process.env.SUPABASE_SECRET_KEY, Authorization:`Bearer ${process.env.SUPABASE_SECRET_KEY}`, ...headers, ...(options.headers||{}) }});
const isAdmin = async auth => { const token=String(auth||'').replace(/^Bearer\s+/i,''); if(!token)return false; const r=await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/is_admin`,{method:'POST',headers:{apikey:process.env.SUPABASE_PUBLISHABLE_KEY,Authorization:`Bearer ${token}`,...headers},body:'{}'}); return r.ok&&(await r.json())===true };
export default async function handler(req,res){
  try{
    if(req.method==='GET'){const r=await db('/rest/v1/inventory?select=color,size,stock,track_stock,allow_preorder,preorder_eta,updated_at&order=color,size');return res.status(r.status).json(await r.json())}
    if(!(await isAdmin(req.headers.authorization)))return res.status(403).json({error:'هذه العملية متاحة لمالك AJLIB فقط'});
    if(req.method!=='PATCH')return res.status(405).json({error:'Method not allowed'});
    const {color,size,stock,track_stock,allow_preorder,preorder_eta}=req.body||{};
    if(!['أسود','كحلي','رمادي','أبيض'].includes(color)||!['M','L','XL','XXL'].includes(size)||!Number.isInteger(Number(stock))||Number(stock)<0)return res.status(400).json({error:'بيانات المخزون غير صحيحة'});
    const r=await db(`/rest/v1/inventory?color=eq.${encodeURIComponent(color)}&size=eq.${encodeURIComponent(size)}`,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({stock:Number(stock),track_stock:Boolean(track_stock),allow_preorder:Boolean(allow_preorder),preorder_eta:String(preorder_eta||'').trim()||null,updated_at:new Date().toISOString()})});
    return res.status(r.status).json(r.ok?(await r.json())[0]:{error:'تعذر حفظ المخزون'});
  }catch(e){return res.status(500).json({error:e.message||'تعذر إدارة المخزون'})}
}
