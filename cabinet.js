(() => {
  'use strict';
  const config = window.FIVEROX_CRM_CONFIG;
  const $ = id => document.getElementById(id);
  const edit = $('editForm'), activity = $('activityForm');
  const keys = ['stage','manager','priority','next','due','amount','closeDate','purchaseDate','purchaseAmount','reason','note','contact','position'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let session = null, db = null, current = null, mode = 'list', busy = false, pending = null;
  let epoch = 0, cardRequest = 0, email = '', proof = '', resendAt = 0, dragged = null;
  const uuid = () => crypto.randomUUID();
  const randomProof = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
  const message = (id, text = '', error = false) => { $(id).textContent = text; $(id).classList.toggle('error',error); };
  const dateLabel = value => value ? value.split('-').reverse().join('.') : 'Не задан';
  const roleLabel = role => role === 'admin' ? 'Администратор' : 'Редактор';
  const canEdit = () => session?.role === 'admin' || session?.role === 'editor';
  const dirty = () => current && keys.some(key => edit.elements[key].value !== current.fields[key]);
  $('release').textContent = config?.release || '';
  if (!config?.backendUrl) {
    $('requestCode').querySelector('button').disabled = true;
    message('loginStatus', 'Вход по коду подключается. Отправка кодов пока недоступна.');
  }

  async function api(method, ...args) {
    if (!config?.backendUrl) throw new Error('Кабинет ещё не подключён к серверу.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    let reply;
    try {
      const response = await fetch(config.backendUrl, { method:'POST', mode:'cors', credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal, headers:{'Content-Type':'text/plain;charset=UTF-8'}, body:JSON.stringify({method,args}) });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      reply = await response.json();
    } catch (cause) {
      const error = new Error('Связь с CRM прервалась. Результат записи пока неизвестен.');
      error.network = true;
      throw error;
    } finally { clearTimeout(timeout); }
    if (reply?.ok === true) return reply.result;
    throw new Error(typeof reply?.error === 'string' ? reply.error : 'Не удалось выполнить запрос.');
  }
  async function rpc(method, ...args) {
    const identity = session, generation = epoch;
    if (!identity) throw new Error('Войдите в кабинет.');
    try {
      const result = await api(method, identity.token, ...args);
      if (generation !== epoch) throw new Error('Сессия изменилась.');
      return result;
    } catch (error) {
      if (generation === epoch && /CRM_AUTH_REQUIRED/.test(error.message)) endSession('Сессия завершилась. Войдите снова.');
      throw error;
    }
  }
  function endSession(text = '') {
    epoch += 1; cardRequest += 1;
    session = db = current = pending = null;
    busy = false;
    $('workspace').hidden = true; $('login').hidden = false; $('record').hidden = true;
    $('results').replaceChildren(); $('history').replaceChildren(); $('cardAudit').replaceChildren(); $('auditEntries').replaceChildren();
    $('metrics').replaceChildren(); $('contacts').replaceChildren(); $('diagnosticEntries').replaceChildren();
    for(const id of ['company','companyMeta','cardFacts','identity','count']) $(id).textContent='';
    $('search').value='';
    fillSelect($('managerFilter'),[],'Все менеджеры');
    for(const id of ['stageFilter','dueFilter','qualificationFilter']) $(id).value='';
    $('admin').hidden=true; $('crmSheet').hidden=true; $('crmSheet').removeAttribute('href');
    edit.reset(); activity.reset(); $('verifyCode').hidden = true; $('requestCode').hidden = false;
    $('verifyCode').reset(); $('retry').hidden = true; $('recovery').hidden = true;
    message('workspaceStatus'); message('cardStatus');
    message('loginStatus',text,Boolean(text));
    setBusy(false);
  }
  function setBusy(value) {
    busy = value;
    for (const control of [...edit.elements,...activity.elements]) control.disabled = value || !canEdit() || Boolean(pending);
    for (const id of ['refresh','reloadCard','discard','listMode','boardMode','queueMode','auditMode']) $(id).disabled = value || Boolean(pending);
    for (const id of ['recover','retry']) $(id).disabled = value;
  }
  function fillSelect(select, values, first) {
    const selected = select.value;
    select.replaceChildren(...(first ? [new Option(first,'')] : []),...values.map(value => new Option(value,value)));
    if (values.includes(selected) || first && selected === '') select.value = selected;
  }
  function dueKind(lead) {
    if (['Клиент','Отказ'].includes(lead.stage)) return 'closed';
    if (!lead.due) return 'none';
    return lead.due < db.today ? 'late' : lead.due === db.today ? 'today' : 'planned';
  }
  function renderMetrics() {
    const rows = db.leads;
    const values = [['Точек в CRM',rows.length],['В работе',rows.filter(row => !['Не обработан','Отложено','Клиент','Отказ'].includes(row.stage)).length],['Просрочено',rows.filter(row => dueKind(row)==='late').length],['Действия сегодня',rows.filter(row => dueKind(row)==='today').length],['Клиенты',rows.filter(row=>row.stage==='Клиент').length]];
    $('metrics').innerHTML = values.map(([label,value])=>'<article class="metric"><span>'+esc(label)+'</span><strong>'+value+'</strong></article>').join('');
  }
  function matches() {
    const query = $('search').value.trim().toLocaleLowerCase('ru-RU');
    return db.leads.filter(lead => (!query || [lead.name,lead.city,lead.id].some(value=>value.toLocaleLowerCase('ru-RU').includes(query))) && (!$('stageFilter').value || lead.stage===$('stageFilter').value) && (!$('managerFilter').value || lead.manager===$('managerFilter').value) && (!$('qualificationFilter').value || lead.qualification===$('qualificationFilter').value) && (!$('dueFilter').value || dueKind(lead)===$('dueFilter').value));
  }
  function recordButton(lead, onBoard = false) {
    const button = document.createElement('button');
    button.type='button'; button.className='record-button'; button.dataset.id=lead.id;
    button.draggable=onBoard && canEdit();
    if (button.draggable) button.classList.add('draggable');
    if (current?.id===lead.id) button.setAttribute('aria-current','true');
    const kind=dueKind(lead), dueText={late:'Просрочено',today:'Сегодня',planned:dateLabel(lead.due),none:'Без срока',closed:'Закрыто'}[kind];
    button.innerHTML='<strong>'+esc(lead.name)+'</strong><p>'+esc([lead.city,lead.profile].filter(Boolean).join(' · '))+'</p><p>'+esc(lead.manager||'Ответственный не назначен')+'</p><span class="pill '+kind+'">'+esc(dueText)+'</span>'+(onBoard?'':' <span class="pill">'+esc(lead.stage)+'</span>');
    return button;
  }
  function renderResults() {
    if (!db || mode==='audit') return;
    let rows=matches();
    if (mode==='queue') {
      const order={late:0,today:1,planned:2,none:3};
      rows=rows.filter(row=>dueKind(row)!=='closed').sort((a,b)=>(order[dueKind(a)]-order[dueKind(b)])||a.due.localeCompare(b.due)||a.name.localeCompare(b.name,'ru'));
    }
    $('count').textContent='Показано '+rows.length+' из '+db.leads.length;
    $('layout').classList.toggle('board-layout',mode==='board');
    if (mode!=='board') $('results').replaceChildren(...rows.map(row=>recordButton(row)));
    else {
      const board=document.createElement('div'); board.className='board'; board.setAttribute('aria-label','Воронка продаж');
      const stages=[...db.stages]; if(rows.some(row=>!stages.includes(row.stage)))stages.push('Без этапа');
      for (const stage of stages) {
        const entries=rows.filter(row=>row.stage===stage || stage==='Без этапа'&&!db.stages.includes(row.stage));
        const column=document.createElement('section');column.className='column';column.dataset.stage=stage;
        const heading=document.createElement('h3');heading.innerHTML=esc(stage)+'<span>'+entries.length+'</span>';
        const list=document.createElement('div');list.className='column-list';list.append(...entries.map(row=>recordButton(row,true)));
        column.append(heading,list);board.append(column);
      }
      $('results').replaceChildren(board);
    }
    if (!rows.length) $('results').innerHTML='<p class="empty">По выбранным условиям точек нет.</p>';
  }
  function auditEntries(target, entries, includeName) {
    target.replaceChildren(...entries.map(entry=>{
      const article=document.createElement('article');article.className='audit-entry';
      const title=document.createElement('strong');title.textContent=[entry.at,entry.actor,entry.action,includeName&&entry.name].filter(Boolean).join(' · ');
      const list=document.createElement('ul');
      for(const change of entry.changes || []){const item=document.createElement('li');item.textContent=change.field+' · '+(change.before===''?'Пусто':change.before)+' → '+(change.after===''?'Пусто':change.after);list.append(item);}
      article.append(title,list);return article;
    }));
    if (!entries.length) target.innerHTML='<p class="empty">Изменений через кабинет пока нет.</p>';
  }
  function renderCard(card) {
    current=card;
    const summary=db.leads.find(row=>row.id===card.id);
    if(summary)Object.assign(summary,{...card.fields,version:card.version});
    $('company').textContent=card.name;
    $('companyMeta').textContent=[card.city,card.address,card.profile,card.qualification,card.id].filter(Boolean).join(' · ');
    $('cardFacts').textContent='Последнее касание · '+dateLabel(card.lastContact)+' · Касаний '+card.contacts+(card.check?' · '+card.check:'');
    const links=[];
    for(const phone of card.phones.split('\n').filter(Boolean)){const a=document.createElement('a');a.textContent=phone;a.href='tel:'+phone.replace(/[^+\d]/g,'');links.push(a);}
    if(card.email){const a=document.createElement('span');a.textContent=card.email;links.push(a);}
    for(const [i,url] of card.links.entries()){if(!/^https:\/\//i.test(url))continue;const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=i?'Яндекс Карты':'2ГИС';links.push(a);}
    for(const url of [card.websites,card.socials].join('\n').split(/\s+/).filter(url=>/^https?:\/\//i.test(url))){const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';try{a.textContent=new URL(url).hostname;}catch{a.textContent='Контакт';}links.push(a);}
    $('contacts').replaceChildren(...links);
    for(const key of keys)edit.elements[key].value=card.fields[key];
    $('history').replaceChildren(...card.history.map(entry=>{const item=document.createElement('article');item.className='history-entry';const title=document.createElement('strong');title.textContent=[entry.at,entry.actor,entry.channel,entry.result].join(' · ');const note=document.createElement('p');note.textContent=entry.note;item.append(title,note);return item;}));
    if(!card.history.length)$('history').innerHTML='<p class="empty">Контакты ещё не записаны.</p>';
    auditEntries($('cardAudit'),card.audit,false);
    $('record').hidden=false;
    renderMetrics();renderResults();setBusy(false);
  }
  async function loadCard(id, force=false) {
    if(busy)return;
    if(pending){message('workspaceStatus','Сначала проверьте результат незавершённого сохранения.',true);return;}
    if(dirty()&&!force){message('cardStatus','Сохраните правки или нажмите «Отменить правки», прежде чем открывать другую карточку.',true);return;}
    const request=++cardRequest,generation=epoch;
    setBusy(true);
    message('workspaceStatus','Открываю карточку…');
    try{const card=await rpc('crmRead',id);if(request!==cardRequest||generation!==epoch)return;pending=null;$('retry').hidden=true;activity.reset();renderCard(card);message('cardStatus');message('workspaceStatus');}
    catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}
    finally{if(generation===epoch&&request===cardRequest)setBusy(false);}
  }
  async function refreshList() {
    const generation=epoch;
    const result=await rpc('crmList');if(generation!==epoch)return;
    db=result;
    fillSelect($('stageFilter'),db.stages,'Все этапы');
    fillSelect($('managerFilter'),[...new Set(db.leads.map(row=>row.manager).filter(Boolean))].sort(),'Все менеджеры');
    fillSelect(edit.elements.stage,db.stages);fillSelect(edit.elements.priority,db.priorities);
    fillSelect(activity.elements.channel,db.actions);fillSelect(activity.elements.result,db.outcomes);
    renderMetrics();renderResults();
  }
  async function mutate(operation) {
    if(busy||!canEdit())return;
    const generation=epoch;
    pending=operation;setBusy(true);$('retry').hidden=true;$('recovery').hidden=true;message('workspaceStatus','Сохраняю…');message('cardStatus','Сохраняю…');
    try{
      await rpc(operation.method,...operation.args);
      if(generation!==epoch)return;
      const id=operation.args[0];
      const card=await rpc('crmRead',id);
      if(generation!==epoch)return;
      pending=null;activity.reset();renderCard(card);message('workspaceStatus');message('cardStatus','Сохранено в CRM и журнале.');
    }catch(error){
      if(generation!==epoch)return;
      if(error.network){
        $('recovery').hidden=false;
        const target=db.leads.find(row=>row.id===operation.args[0]);
        message('workspaceStatus','Не удалось подтвердить сохранение'+(target?' «'+target.name+'»':'')+'. Проверьте результат, затем подтвердите сохранение.',true);
        message('cardStatus','До подтверждения сохранения форма временно недоступна.',true);
      }else{
        pending=null;
        let text=error.message;
        if(operation.method==='crmMove'&&/CRM_CONFLICT/.test(error.message)){
          try{const card=await rpc('crmRead',operation.args[0]);if(generation!==epoch)return;renderCard(card);text='Этап уже изменён. Показано актуальное состояние карточки.';}catch{}
        }
        message('workspaceStatus',text,true);message('cardStatus',text,true);
      }
    }finally{if(generation===epoch)setBusy(false);}
  }
  async function recoverPending() {
    if(busy||!pending)return;
    const generation=epoch,operation=pending;
    setBusy(true);message('workspaceStatus','Проверяю сохранённые данные…');
    try{
      const card=await rpc('crmRead',operation.args[0]);
      if(generation!==epoch)return;
      renderCard(card);
      $('retry').hidden=false;
      message('workspaceStatus','Сохранённые данные «'+card.name+'» загружены. Подтвердите сохранение: уже записанное касание не продублируется.');
      message('cardStatus','Проверьте сохранённые значения и историю общения.');
    }catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}
    finally{if(generation===epoch)setBusy(false);}
  }
  edit.addEventListener('submit',event=>{event.preventDefault();if(!current||pending||busy)return;const patch={};for(const key of keys)if(edit.elements[key].value!==current.fields[key])patch[key]=edit.elements[key].value;if(!Object.keys(patch).length){message('cardStatus','Изменений нет.');return;}mutate({method:'crmSave',args:[current.id,current.version,patch,uuid()]});});
  activity.addEventListener('submit',event=>{event.preventDefault();if(!current||pending||busy)return;if(dirty()){message('cardStatus','Сначала сохраните правки карточки.',true);return;}mutate({method:'crmRecord',args:[current.id,{channel:activity.elements.channel.value,result:activity.elements.result.value,note:activity.elements.note.value},uuid()]});});
  $('retry').addEventListener('click',()=>{if(pending)mutate(pending);});
  $('recover').addEventListener('click',recoverPending);
  $('reloadCard').addEventListener('click',()=>{if(!current)return;if(dirty()&&!pending){message('cardStatus','Нажмите «Отменить правки», чтобы загрузить сохранённую версию. Текст остаётся в форме.',true);return;}loadCard(current.id,true);});
  $('discard').addEventListener('click',()=>{if(!current||busy)return;loadCard(current.id,true);});
  $('results').addEventListener('click',event=>{const button=event.target.closest('button[data-id]');if(button)loadCard(button.dataset.id);});
  $('results').addEventListener('dragstart',event=>{const button=event.target.closest('button[data-id]');if(!button||!canEdit()||busy||dirty()||pending){event.preventDefault();return;}dragged=button.dataset.id;event.dataTransfer.setData('text/plain',dragged);event.dataTransfer.effectAllowed='move';});
  $('results').addEventListener('dragover',event=>{const column=event.target.closest('.column');if(!dragged||!column||!db.stages.includes(column.dataset.stage))return;event.preventDefault();column.classList.add('drop-target');});
  $('results').addEventListener('dragleave',event=>event.target.closest('.column')?.classList.remove('drop-target'));
  $('results').addEventListener('dragend',()=>{dragged=null;document.querySelectorAll('.drop-target').forEach(node=>node.classList.remove('drop-target'));});
  $('results').addEventListener('drop',event=>{const stage=event.target.closest('.column')?.dataset.stage;const lead=db?.leads.find(row=>row.id===dragged);dragged=null;if(!lead||!db.stages.includes(stage)||stage===lead.stage)return;event.preventDefault();mutate({method:'crmMove',args:[lead.id,lead.version,stage,uuid()]});});
  for(const id of ['search','stageFilter','managerFilter','dueFilter','qualificationFilter'])$(id).addEventListener(id==='search'?'input':'change',renderResults);
  async function setMode(value) {
    mode=value;
    for(const name of ['list','board','queue','audit'])$(name+'Mode').setAttribute('aria-pressed',name===value);
    $('layout').hidden=value==='audit';$('auditPanel').hidden=value!=='audit';
    if(value==='audit'){const generation=epoch;message('workspaceStatus','Читаю журнал…');try{const entries=await rpc('crmAuditList');if(generation!==epoch)return;auditEntries($('auditEntries'),entries,true);message('workspaceStatus');}catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}}
    else renderResults();
  }
  for(const name of ['list','board','queue','audit'])$(name+'Mode').addEventListener('click',()=>setMode(name));
  $('refresh').addEventListener('click',async()=>{
    if(busy)return;
    if(dirty()||pending){message('cardStatus','Сначала завершите правки карточки.',true);return;}
    const generation=epoch,id=current?.id;
    setBusy(true);message('workspaceStatus','Обновляю…');
    try{
      await refreshList();if(generation!==epoch)return;
      if(id){const card=await rpc('crmRead',id);if(generation!==epoch)return;renderCard(card);}
      message('workspaceStatus');message('cardStatus');
    }catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}
    finally{if(generation===epoch)setBusy(false);}
  });
  $('logout').addEventListener('click',async()=>{const token=session?.token;endSession();if(token)try{await api('crmEmailLogout',token);}catch{message('loginStatus','Карточки закрыты. Сервер не подтвердил выход. Сессия истечёт автоматически.');}});
  $('diagnostics').addEventListener('click',async()=>{try{const entries=await rpc('crmDiagnostics');const labels={submitted:'Передано отправителю',ineligible:'Адрес не допущен',throttled:'Лимит частоты',quota_exhausted:'Почтовая квота исчерпана',transport_failure:'Ошибка отправки',not_configured:'Отправка не настроена',internal_failure:'Ошибка сервера'};$('diagnosticEntries').replaceChildren(...entries.slice().reverse().map(entry=>{const item=document.createElement('p');item.textContent=[entry.at,labels[entry.result]||entry.result,entry.requestId].join(' · ');return item;}));}catch(error){message('workspaceStatus',error.message,true);}});
  async function requestCode() {
    const generation=epoch;
    email=$('requestCode').elements.email.value.trim();proof=randomProof();
    const button=$('requestCode').querySelector('button');button.disabled=true;message('loginStatus','Запрашиваю код…');
    try{const reply=await api('crmEmailStart',email,proof);if(generation!==epoch)return;resendAt=Date.now()+90000;$('requestCode').hidden=true;$('verifyCode').hidden=false;$('destination').textContent='Адрес входа · '+email;message('loginStatus','Запрос принят. Если этому адресу выдан доступ, код придёт на почту. Номер запроса '+reply.requestId);}
    catch(error){if(generation===epoch)message('loginStatus',error.message,true);}finally{button.disabled=false;}
  }
  $('requestCode').addEventListener('submit',event=>{event.preventDefault();requestCode();});
  $('changeEmail').addEventListener('click',()=>{epoch+=1;proof='';$('verifyCode').reset();$('verifyCode').hidden=true;$('requestCode').hidden=false;message('loginStatus');});
  $('resend').addEventListener('click',()=>{if(Date.now()<resendAt){message('loginStatus','Повторная отправка доступна через '+Math.ceil((resendAt-Date.now())/1000)+' сек.',true);return;}requestCode();});
  $('verifyCode').addEventListener('submit',async event=>{
    event.preventDefault();const generation=epoch;const button=$('verifyCode').querySelector('button');button.disabled=true;
    try{
      message('loginStatus','Проверяю код…');
      const result=await api('crmEmailVerify',email,proof,$('verifyCode').elements.code.value.trim());
      $('verifyCode').elements.code.value='';if(generation!==epoch)return;
      session={...result.session,token:result.token};const identity=await rpc('crmSession');Object.assign(session,identity);
      await refreshList();if(generation!==epoch)return;
      $('identity').textContent=session.email+' · '+roleLabel(session.role);
      $('admin').hidden=session.role!=='admin';$('crmSheet').hidden=session.role!=='admin';
      if(session.sheetUrl)$('crmSheet').href=session.sheetUrl;
      $('login').hidden=true;$('workspace').hidden=false;message('workspaceStatus');setMode('list');
    }catch(error){if(generation===epoch)message('loginStatus',error.message,true);}finally{button.disabled=false;}
  });
  window.addEventListener('beforeunload',event=>{if(session&&(dirty()||pending||activity.elements.note.value)){event.preventDefault();event.returnValue='';}});
})();
