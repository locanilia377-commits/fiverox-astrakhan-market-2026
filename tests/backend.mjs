import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';

const values = new Map(), outbox = [];
let now = Date.parse('2026-11-11T19:00:00Z');
class TestDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const owner = 'owner@example.test';
let editors = ['manager@example.test'];
const user = email => ({getEmail:()=>email});
const book = {getOwner:()=>user(owner),getEditors:()=>editors.map(user)};
const properties = {getProperty:key=>values.get(key)??null,setProperty:(key,value)=>values.set(key,value),setProperties:object=>Object.entries(object).forEach(([key,value])=>values.set(key,value))};
function localDate(date) { return new Date(date.getTime()+3*3600000).toISOString(); }
const context = vm.createContext({
  Date:TestDate, console:{info(){},warn(){}},
  SpreadsheetApp:{openById:()=>book},
  Session:{getActiveUser:()=>user(owner),getEffectiveUser:()=>user(owner)},
  PropertiesService:{getScriptProperties:()=>properties},
  LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  MailApp:{getRemainingDailyQuota:()=>100,sendEmail:mail=>outbox.push(mail)},
  Utilities:{
    getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},
    computeDigest:(algorithm,text)=>Array.from(crypto.createHash('sha256').update(text).digest()),
    computeHmacSha256Signature:(text,secret)=>Array.from(crypto.createHmac('sha256',secret).update(text).digest()),
    formatDate:(date,tz,pattern)=>pattern==='yyyy-MM-dd'?localDate(date).slice(0,10):localDate(date).replace('T',' ').slice(0,19),
    parseDate:value=>new TestDate(Date.parse(value+'T00:00:00+03:00'))
  },
  ContentService:{MimeType:{JSON:'json'},createTextOutput:text=>({text,setMimeType(){return this;}})},
  Sheets:{Spreadsheets:{batchUpdate(){throw Error('Injected audit write failure');}}}
});
// Apps Script uses parseDate(value, timezone, pattern).
context.Utilities.parseDate=(value)=>new TestDate(Date.parse(value+'T00:00:00+03:00'));
vm.runInContext(fs.readFileSync(new URL('../apps-script/Code.gs',import.meta.url),'utf8'),context);
const checks=[];
context.MailApp.getRemainingDailyQuota=()=>{throw Error('Missing permission script.send_mail');};
const partialSetup=context.crmEmailSetup_();
assert.equal(partialSetup.enabled,true); assert.equal(partialSetup.mailReady,false);
assert.equal(partialSetup.mailError,'mail_authorization_required');
assert.throws(()=>context.crmSession(''));
const blockedDelivery=context.crmEmailStart(owner,'f'.repeat(64));
assert.equal(blockedDelivery.accepted,true); assert.equal(outbox.length,0);
assert.equal(JSON.parse(values.get('CRM_AUTH_DIAGNOSTICS')).at(-1).result,'mail_authorization_required');
const initializedSecret=context.crmEmailSecret_(properties);
context.MailApp.getRemainingDailyQuota=()=>100;
assert.equal(context.crmEmailSetup_().mailReady,true);
assert.equal(context.crmEmailSecret_(properties),initializedSecret);
checks.push('Owner bootstrap survives mail permission failure; closed data stays protected and recovery preserves the secret');
context.MailApp.sendEmail=()=>{throw Error('Temporary transport failure');};
const failedTransport=context.crmEmailStart(owner,'1'.repeat(64));
assert.equal(failedTransport.accepted,true); assert.ok(failedTransport.requestId);
assert.equal(JSON.parse(values.get('CRM_AUTH_DIAGNOSTICS')).at(-1).result,'transport_failure');
assert.equal(context.crmEmailRecord_(properties,context.crmEmailUserKey_(context.crmEmailMailbox_(owner)),owner).challenges.length,0);
now+=91000; context.MailApp.sendEmail=mail=>outbox.push(mail);
checks.push('Failed delivery keeps the correlation response and removes the unusable challenge');
const proof='a'.repeat(64);
context.crmEmailStart(owner,proof);
assert.equal(outbox.length,1);
const code=outbox[0].body.match(/\b\d{8}\b/)[0];
assert.throws(()=>context.crmEmailVerify(owner,'b'.repeat(64),code));
assert.throws(()=>context.crmEmailVerify(owner,proof,'00000000'===code?'11111111':'00000000'));
const login=context.crmEmailVerify(owner,proof,code);
assert.equal(context.crmSession(login.token).role,'admin');
assert.throws(()=>context.crmEmailVerify(owner,proof,code));
checks.push('Browser proof, wrong code, one-time code and owner session');
context.crmEmailStart('outsider@example.test','c'.repeat(64));
assert.equal(outbox.length,1);
assert.throws(()=>context.crmList(''));
checks.push('Unknown email is not sent a code; anonymous private read is denied');
context.crmEmailStart(owner,'d'.repeat(64));
assert.equal(outbox.length,1);
checks.push('Repeated sending is rate limited');
context.crmEmailStart(editors[0],'e'.repeat(64));
const managerCode=outbox[1].body.match(/\b\d{8}\b/)[0];
const manager=context.crmEmailVerify(editors[0],'e'.repeat(64),managerCode);
assert.equal(context.crmSession(manager.token).role,'editor');
assert.throws(()=>context.crmDiagnostics(manager.token));
editors=[];
assert.throws(()=>context.crmSession(manager.token));
checks.push('Editor cannot use admin diagnostics; revoking ACL invalidates the next request');
context.crmEmailLogout(login.token);
assert.throws(()=>context.crmSession(login.token));
checks.push('Logout revokes the server session');
const literal=context.crmCell_('=IMPORTXML("https://example.invalid")');
assert.equal(literal.userEnteredValue.stringValue,'=IMPORTXML("https://example.invalid")');
assert.equal(literal.userEnteredValue.formulaValue,undefined);
assert.equal(context.crmValidate_('amount','0'),0);
assert.equal(context.crmValidate_('amount','12.34'),12.34);
assert.equal(context.crmValidate_('amount',''),'');
assert.throws(()=>context.crmValidate_('amount','-1'));
assert.throws(()=>context.crmValidate_('amount','12.345'));
assert.throws(()=>context.crmValidate_('stage','INVALID'));
assert.throws(()=>context.crmValidate_('due','2026-02-30'));
checks.push('Literal formula-like text, blank vs zero, cents and invalid values');
const op=crypto.randomUUID();
const opRow=[op,owner,'Y-123','Правка карточки','fingerprint','2026-11-11 22:00:00','{"saved":true}'];
const opSheet={getLastRow:()=>2,getRange:(row,col,height,width)=>({createTextFinder:()=>({matchEntireCell(){return this;},findAll:()=>[{getRow:()=>2}]}),getDisplayValues:()=>[opRow]})};
const opBook={getSheetByName:()=>opSheet};
assert.equal(context.crmOperation_(opBook,owner,op,'Правка карточки','Y-123','fingerprint').saved,true);
assert.throws(()=>context.crmOperation_(opBook,owner,op,'Правка карточки','Y-123','other'));
assert.throws(()=>context.crmOperation_(opBook,'someone@example.test',op,'Правка карточки','Y-123','fingerprint'));
checks.push('Operation ID binds author, record and payload; matching replay returns saved result');
let atomicRequests;
context.Sheets.Spreadsheets.batchUpdate=(body)=>{atomicRequests=body.requests;throw Error('Injected audit failure');};
const auditBook={getId:()=> 'test-book',getSheetByName:name=>({getSheetId:()=>name==='Журнал CRM'?10:11})};
assert.throws(()=>context.crmCommit_({book:auditBook,email:owner},{id:'Y-123',name:'TEST'},[{field:'Этап',before:'A',after:'B'}],[{updateCells:{}}],op,'Правка карточки','fingerprint',{saved:true}));
assert.equal(atomicRequests.length,3);
assert.ok(atomicRequests[0].updateCells);
assert.equal(atomicRequests[1].appendCells.sheetId,10);
assert.equal(atomicRequests[2].appendCells.sheetId,11);
checks.push('Card write, audit and idempotency record use one atomic batch; failure propagates');
const denial=JSON.parse(context.doPost({postData:{type:'text/plain;charset=UTF-8',contents:JSON.stringify({method:'setupAstrakhanCrm',args:[]})}}).text);
assert.equal(denial.ok,false);
checks.push('Public RPC cannot invoke setup');
fs.writeFileSync(new URL('backend-local-qa.json',import.meta.url),JSON.stringify({level:'local',checks},null,2));
console.log(JSON.stringify({passed:checks.length,checks}));
