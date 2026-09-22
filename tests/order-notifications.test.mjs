import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { customerNotificationCopy, safeTrackingForNotification, deliverOrderNotifications } from '../api/_lib/order-notifications.js';
import { buildTrackingPatch } from '../api/_lib/fulfillment-tracking.js';
import { customerStatusFor, serializeOrderForCustomer } from '../api/_lib/fulfillment-status.js';

const STATUSES = ['ORDER_RECEIVED','PREPARING_ORDER','PREPARING_SHIPMENT','SHIPPED','DELIVERED'];
for (const status of STATUSES) test(`${status} has safe Arabic and English email/push copy`, () => {
  for (const language of ['ar','en']) {
    const copy = customerNotificationCopy(status,language,'AJ12345678');
    assert.match(copy.title, /\S/);
    assert.match(copy.body, /AJ12345678/);
    assert.doesNotMatch(JSON.stringify(copy), /CJ|WAITING_FOR_CJ_PAYMENT|REVIEW_REQUIRED|SUBMITTING/);
  }
});
test('tracking remains hidden until shipped, even if the provider stored it early', () => {
  const row = { order_number:'AJ12345678',status:'packed',tracking_number:'YT1',shipping_company:'YunExpress',fulfillment_tracking_url:'https://t.17track.net/en#nums=YT1' };
  assert.equal(safeTrackingForNotification(row,'PREPARING_SHIPMENT'),null);
  assert.equal(serializeOrderForCustomer(row).tracking_number,null);
  assert.equal(safeTrackingForNotification(row,'SHIPPED').number,'YT1');
  assert.equal(customerStatusFor('shipped'),'SHIPPED');
});
test('a CJ DISPATCHED order advances to shipped and publishes previously stored tracking', () => {
  const order = { status:'packed',fulfillment_tracking_number:'YT1',fulfillment_carrier:'YunExpress' };
  const { cjStatus,patch } = buildTrackingPatch(order,{orderStatus:'DISPATCHED'},null,'2026-09-22T12:00:00Z');
  assert.equal(cjStatus,'DISPATCHED');
  assert.equal(patch.status,'shipped');
  assert.equal(patch.tracking_number,'YT1');
  assert.equal(patch.shipping_company,'YunExpress');
});
test('CJ last-mile Updating placeholder never replaces a real shipped tracking number', () => {
  const detail = { orderStatus:'DISPATCHED', trackNumber:'YT2626200701846673' };
  const track = { trackingNumber:'YT2626200701846673', lastTrackNumber:'Updating' };
  const first = buildTrackingPatch({ status:'packed', tracking_number:null }, detail, track);
  assert.equal(first.patch.tracking_number,'YT2626200701846673');
  const recovery = buildTrackingPatch({ status:'shipped', tracking_number:'Updating' }, detail, track);
  assert.equal(recovery.patch.tracking_number,'YT2626200701846673');
  assert.equal(recovery.patch.status,undefined,'tracking repair must not create another status transition');
});
test('the additive migration queues only real safe transitions with unique per-channel events and private ownership', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260922190000_order_status_notifications.sql',import.meta.url),'utf8');
  assert.match(sql,/unique \(order_id, customer_status, channel\)/);
  assert.match(sql,/is not distinct from v_status/);
  assert.match(sql,/after insert or update of status/);
  assert.match(sql,/for update skip locked/);
  assert.match(sql,/auth\.uid\(\)/);
  assert.match(sql,/revoke all on public\.order_notifications, public\.order_notification_events, public\.order_push_tokens, public\.order_push_deliveries from public, anon, authenticated/);
  assert.match(sql,/then o\.tracking_number else null/);
  assert.doesNotMatch(sql,/insert into public\.order_notification_events\s+select/i,'existing orders must not be backfilled');
});
test('status email links to the owned order without exposing fulfillment data', async () => {
  const worker = await readFile(new URL('../api/_lib/order-notifications.js',import.meta.url),'utf8');
  const site = await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(worker,/\?order=\$\{encodeURIComponent\(order\.order_number\)\}/);
  assert.match(site,/const linkedOrderNumber=.*\^AJ/);
  assert.match(site,/rows\.find\(o=>o\.order_number===linkedOrderNumber\)/);
  assert.match(site,/if\(linkedOrderNumber\)setTimeout\(openAccount,0\)/);
});

const reply = (data,status=200) => ({ ok:status>=200&&status<300,status,
  text:async()=>data===null?'':JSON.stringify(data),json:async()=>data });
const withWorld = async (events, work, { resendFails = false, resendThrows = false, expoTicket = { status:'ok',id:'ticket-1' }, tokens = [{id:'token-1',token:'ExpoPushToken[abcdefghijklmnop]'}], orderStatus = 'shipped' } = {}) => {
  const priorFetch=globalThis.fetch, priorEnv={ SUPABASE_URL:process.env.SUPABASE_URL,SUPABASE_SECRET_KEY:process.env.SUPABASE_SECRET_KEY,RESEND_API_KEY:process.env.RESEND_API_KEY };
  process.env.SUPABASE_URL='https://test.supabase.co';process.env.SUPABASE_SECRET_KEY='test-secret';process.env.RESEND_API_KEY='test-resend';
  const calls={email:0,push:0,events:[],tokens:[],deliveries:[]};
  let claimed=false;
  globalThis.fetch=async (input,options={})=>{
    const url=String(input),body=options.body?JSON.parse(options.body):null;
    if(url.endsWith('/rpc/claim_order_notification_events')){const batch=claimed?[]:events;claimed=true;return reply(batch)}
    if(url.includes('/rest/v1/orders?'))return reply([{id:'order-1',order_number:'AJ12345678',customer_email:'customer@example.test',user_id:'user-1',status:orderStatus,tracking_number:'YT1',shipping_company:'YunExpress',fulfillment_tracking_url:'https://t.17track.net/en#nums=YT1'}]);
    if(url.includes('/rest/v1/order_notifications?'))return reply([{user_id:'user-1'}]);
    if(url.includes('/rest/v1/profiles?'))return reply([{preferred_language:'ar'}]);
    if(url.includes('/rest/v1/order_push_tokens?')&&options.method==='PATCH'){calls.tokens.push(body);return reply(null)}
    if(url.includes('/rest/v1/order_push_tokens?'))return reply(tokens);
    if(url.includes('/rest/v1/order_push_deliveries?')&&options.method==='POST')return reply(null);
    if(url.includes('/rest/v1/order_push_deliveries?')&&options.method==='PATCH'){calls.deliveries.push(body);return reply(null)}
    if(url.includes('/rest/v1/order_push_deliveries?')&&url.includes('state=in.'))return reply([]);
    if(url.includes('/rest/v1/order_push_deliveries?')&&url.includes('receipt_checked_at=is.null'))return reply([]);
    if(url.includes('/rest/v1/order_push_deliveries?'))return reply([{state:'pending'}]);
    if(url.includes('/rest/v1/order_notification_events?')&&options.method==='PATCH'){calls.events.push(body);return reply(null)}
    if(url==='https://api.resend.com/emails'){calls.email++;if(resendThrows)throw new Error('Connection lost');return reply(resendFails?{message:'fail'}:{id:'email-1'},resendFails?503:200)}
    if(url.endsWith('/push/send')){calls.push++;return reply({data:expoTicket})}
    throw new Error(`Unexpected test request ${url}`);
  };
  try{return await work(calls)}finally{
    globalThis.fetch=priorFetch;
    for(const [key,value] of Object.entries(priorEnv)) if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
};

test('one event per channel sends once, and a repeated cron claim sends nothing', async () => {
  await withWorld([
    {id:'event-email',order_id:'order-1',customer_status:'SHIPPED',channel:'email',attempts:1},
    {id:'event-push',order_id:'order-1',customer_status:'SHIPPED',channel:'push',attempts:1}
  ],async calls=>{
    assert.equal((await deliverOrderNotifications()).failed,0);
    assert.equal((await deliverOrderNotifications()).processed,0);
    assert.equal(calls.email,1);assert.equal(calls.push,1);
    assert.equal(calls.events.filter(event=>event.state==='sent').length,2);
    assert.equal(calls.deliveries.find(event=>event.state==='sent').ticket_id,'ticket-1');
  });
});
test('email failure is saved for retry without breaking fulfillment or sending a push twice', async () => {
  await withWorld([{id:'event-email',order_id:'order-1',customer_status:'SHIPPED',channel:'email',attempts:1}],async calls=>{
    assert.equal((await deliverOrderNotifications()).failed,1);
    assert.equal(calls.events[0].state,'failed');
  },{resendFails:true});
});
test('ambiguous email network outcome is quarantined instead of risking a duplicate', async () => {
  await withWorld([{id:'event-email',order_id:'order-1',customer_status:'SHIPPED',channel:'email',attempts:1}],async calls=>{
    assert.equal((await deliverOrderNotifications()).failed,1);
    assert.equal(calls.events[0].state,'indeterminate');
  },{resendThrows:true});
});
test('invalid Expo token is disabled and never sent again', async () => {
  await withWorld([{id:'event-push',order_id:'order-1',customer_status:'SHIPPED',channel:'push',attempts:1}],async calls=>{
    assert.equal((await deliverOrderNotifications()).failed,0);
    assert.deepEqual(calls.tokens,[{enabled:false}]);
  },{expoTicket:{status:'error',details:{error:'DeviceNotRegistered'}}});
});
test('a newest-stage push stays pending when Build 20 has no registered device', async () => {
  await withWorld([{id:'event-push',order_id:'order-1',customer_status:'SHIPPED',channel:'push',attempts:1}],async calls=>{
    assert.equal((await deliverOrderNotifications()).failed,1);
    assert.equal(calls.push,0);
    assert.equal(calls.events[0].state,'failed');
  },{tokens:[]});
});
test('a delayed obsolete push is skipped after the order reaches a later stage', async () => {
  await withWorld([{id:'event-push',order_id:'order-1',customer_status:'SHIPPED',channel:'push',attempts:1}],async calls=>{
    assert.equal((await deliverOrderNotifications()).failed,0);
    assert.equal(calls.push,0);
    assert.equal(calls.events[0].state,'sent');
  },{orderStatus:'delivered'});
});
