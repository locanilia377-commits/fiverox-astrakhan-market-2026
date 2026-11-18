(() => {
  'use strict';
  const config = window.FIVEROX_CRM_CONFIG;
  const $ = id => document.getElementById(id);
  const edit = $('editForm'), activity = $('activityForm');
  const keys = ['stage','manager','priority','next','due','amount','closeDate','purchaseDate','purchaseAmount','reason','note','contact','position'];
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  let session = null, db = null, current = null, mode = 'list', busy = false, pending = null;
  let epoch = 0, cardRequest = 0, email = '', proof = '', resendAt = 0;
  const moves = new Map();
  let moveQueue = Promise.resolve();
  const storageKey = 'fiverox.astrakhan.crm.session.v1';
  const modeKey = 'fiverox.astrakhan.crm.mode.v1';
  function storage(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      if (value === null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, value);
    } catch { /* The current tab can still work without storage. */ }
    return null;
  }
  let fast = false;
  const sectionLinks = [...document.querySelectorAll('[data-section]')];
  let renderedSection = null;
  function showSection() {
    const requested = location.hash.slice(1);
    const section = ['market','leads','model'].includes(requested) ? requested : 'crm';
    const reading = section !== 'crm';
    $('main').hidden = reading;
    $('research').hidden = !reading;
    if (reading && renderedSection !== section) {
      $('researchFrame').src = './index.html?embed=cabinet#' + section;
      renderedSection = section;
    }
    for (const link of sectionLinks) {
      if (link.dataset.section === section) link.setAttribute('aria-current','page');
      else link.removeAttribute('aria-current');
    }
  }
  for (const link of sectionLinks) link.addEventListener('click', event => {
    if (link.dataset.section !== 'crm' && (dirty() || activity.elements.note.value || regionalDirty())) {
      event.preventDefault();
      message('cardStatus','Сохраните или отмените правки перед переходом.',true);
    }
  });
  window.addEventListener('hashchange',showSection);
  showSection();
  const uuid = () => crypto.randomUUID();
  const randomProof = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2,'0')).join('');
  const message = (id, text = '', error = false) => { $(id).textContent = text; $(id).classList.toggle('error',error); };
  const dateLabel = value => value ? value.split('-').reverse().join('.') : 'Не задан';
  const roleLabel = role => role === 'admin' ? 'Администратор' : 'Редактор';
  const canEdit = () => session?.role === 'admin' || session?.role === 'editor';
  const dirty = () => current?.fields && keys.some(key => edit.elements[key].value !== current.fields[key]);
  $('release').textContent = config?.release || '';
  if (!config?.backendUrl) {
    $('requestCode').querySelector('button').disabled = true;
    message('loginStatus', 'Вход по коду подключается. Отправка кодов пока недоступна.');
  }

  function transportError(kind, retryable, message) {
    return Object.assign(new Error(message), { network: true, retryable, kind });
  }
  async function postRpc(method, args, timeoutMs) {
    if (!config?.backendUrl) throw new Error('Кабинет ещё не подключён к серверу.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let reply;
    try {
      const response = await fetch(config.backendUrl, { method:'POST', mode:'cors', credentials:'omit', referrerPolicy:'no-referrer', signal:controller.signal, headers:{'Content-Type':'text/plain;charset=UTF-8'}, body:JSON.stringify({method,args}) });
      if (!response.ok) {
        const retryable = [408, 500, 502, 503, 504].includes(response.status);
        throw transportError('http', retryable, 'Сервер CRM вернул HTTP ' + response.status + '.');
      }
      reply = await response.json();
    } catch (cause) {
      if (cause?.network) throw cause;
      const kind = controller.signal.aborted ? 'timeout' : cause instanceof SyntaxError ? 'format' : 'connection';
      throw transportError(kind, kind !== 'format', 'Связь с CRM прервалась.');
    } finally { clearTimeout(timeout); }
    if (reply?.ok === true && Object.hasOwn(reply,'result')) return reply.result;
    const error = new Error(typeof reply?.error === 'string' ? reply.error : 'CRM вернула неполный ответ.');
    error.network = typeof reply?.error !== 'string' || error.message.startsWith('CRM_WRITE_UNCERTAIN:');
    throw error;
  }
  const api = (method, ...args) => postRpc(method, args, 45000);
  async function authenticatedRequest(send) {
    const identity = session, generation = epoch;
    if (!identity) throw new Error('Войдите в кабинет.');
    try {
      const result = await send(identity.token);
      if (generation !== epoch) throw new Error('Сессия изменилась.');
      return result;
    } catch (error) {
      if (generation === epoch && /CRM_AUTH_REQUIRED/.test(error.message)) endSession('Сессия завершилась. Войдите снова.');
      throw error;
    }
  }
  const rpc = (method, ...args) => authenticatedRequest(token => api(method, token, ...args));
  async function requestRefresh(id) {
    const generation = epoch;
    const request = timeoutMs => authenticatedRequest(token => postRpc('crmRefresh', [token, id], timeoutMs));
    try {
      return await request(9000);
    } catch (error) {
      if (generation !== epoch || !error.retryable) throw error;
      message('workspaceStatus','Связь прервалась. Повторяю обновление…');
      return request(11000);
    }
  }
  function endSession(text = '') {
    epoch += 1; cardRequest += 1;
    session = db = current = pending = null;
    clearRegionalWorkspace();
    stopGesture();
    storage(storageKey, null);
    storage(modeKey, null);
    moves.clear();
    moveQueue = Promise.resolve();
    $('moveRetry').replaceChildren();
    $('moveRetry').hidden = true;
    message('moveStatus');
    $('resume').hidden = true;
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
    for (const control of [...edit.elements,...activity.elements]) control.disabled = value || !canEdit() || Boolean(pending) || !current?.fields || moves.has(current.id);
    for (const id of ['refresh','reloadCard','discard','listMode','boardMode','queueMode','auditMode']) $(id).disabled = value || Boolean(pending) || (id === 'refresh' && moves.size > 0);
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
    return db.leads.filter(lead => (!query || [lead.name,lead.city,lead.id].some(value=>value.toLocaleLowerCase('ru-RU').includes(query))) && (!$('stageFilter').value || lead.stage===$('stageFilter').value || moves.has(lead.id)) && (!$('managerFilter').value || lead.manager===$('managerFilter').value) && (!$('qualificationFilter').value || lead.qualification===$('qualificationFilter').value) && (!$('dueFilter').value || dueKind(lead)===$('dueFilter').value));
  }
  function recordButton(lead, onBoard = false) {
    const button = document.createElement('button');
    button.type='button'; button.className='record-button'; button.dataset.id=lead.id;
    button.classList.toggle('draggable',onBoard && canEdit() && !moves.has(lead.id));
    const move = moves.get(lead.id);
    if (move) button.dataset.moveState = move.state;
    if (current?.id===lead.id) button.setAttribute('aria-current','true');
    const kind=dueKind(lead), dueText={late:'Просрочено',today:'Сегодня',planned:dateLabel(lead.due),none:'Без срока',closed:'Закрыто'}[kind];
    button.innerHTML='<strong>'+esc(lead.name)+'</strong><p>'+esc([lead.city,lead.profile].filter(Boolean).join(' · '))+'</p><p>'+esc(lead.manager||'Ответственный не назначен')+'</p><span class="pill '+kind+'">'+esc(dueText)+'</span>'+(onBoard?'':' <span class="pill">'+esc(lead.stage)+'</span>');
    if (move) {
      const status = document.createElement('span');
      status.className = 'move-state';
      status.textContent = move.state === 'unknown' ? 'Этап не подтверждён' : 'Сохраняется этап…';
      button.append(status);
    }
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
      const previousBoard = $('results').querySelector('.board');
      const scrollLeft = previousBoard?.scrollLeft || 0;
      const columnScroll = new Map([...previousBoard?.querySelectorAll('.column') || []]
        .map(column => [column.dataset.stage,column.querySelector('.column-list').scrollTop]));
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
      board.scrollLeft = scrollLeft;
      for (const column of board.children) column.querySelector('.column-list').scrollTop = columnScroll.get(column.dataset.stage) || 0;
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
    $('history').replaceChildren();
    $('cardAudit').replaceChildren();
    $('historySection').open = false;
    $('cardAuditSection').open = false;
    $('record').hidden=false;
    renderMetrics();renderResults();setBusy(false);
  }
  function applyCanonical(card) {
    const summary = db.leads.find(row => row.id === card.id);
    if (summary) Object.assign(summary, card.fields, { version: card.version });
    if (current?.id === card.id && current.fields && !dirty()) {
      Object.assign(current, card);
      for (const key of keys) edit.elements[key].value = current.fields[key];
      $('cardFacts').textContent='Последнее касание · '+dateLabel(current.lastContact)+' · Касаний '+current.contacts+(current.check?' · '+current.check:'');
      $('cardAudit').replaceChildren();
      if ($('cardAuditSection').open) loadCardLog(true);
    }
    renderMetrics();
    renderResults();
    setBusy(busy);
  }

  async function loadCardLog(audit) {
    if (!current?.fields) return;
    const card = current, request = cardRequest, generation = epoch;
    const target = $(audit ? 'cardAudit' : 'history');
    target.textContent = 'Загружаю…';
    try {
      const entries = fast ? await rpc(audit ? 'crmCardAudit' : 'crmHistory', card.id)
        : (await rpc('crmRead',card.id))[audit ? 'audit' : 'history'];
      if (generation !== epoch || request !== cardRequest || card !== current) return;
      if (audit) return auditEntries(target, entries, false);
      target.replaceChildren(...entries.map(entry => {
        const item = document.createElement('article');
        item.className = 'history-entry';
        const title = document.createElement('strong');
        title.textContent = [entry.at,entry.actor,entry.channel,entry.result].join(' · ');
        const note = document.createElement('p');
        note.textContent = entry.note;
        item.append(title,note);
        return item;
      }));
      if (!entries.length) target.textContent = 'Контакты ещё не записаны.';
    } catch (error) {
      if (generation !== epoch || request !== cardRequest || card !== current) return;
      target.textContent = '';
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = 'Повторить загрузку';
      retry.addEventListener('click',() => loadCardLog(audit));
      target.append(retry);
    }
  }
  $('historySection').addEventListener('toggle',() => { if ($('historySection').open) loadCardLog(false); });
  $('cardAuditSection').addEventListener('toggle',() => { if ($('cardAuditSection').open) loadCardLog(true); });
  const fetchCard = id => rpc(fast ? 'crmOverview' : 'crmRead',id);
  async function loadCard(id, force=false) {
    if(busy)return;
    if(pending){message('workspaceStatus','Сначала проверьте результат незавершённого сохранения.',true);return;}
    if((dirty() || activity.elements.note.value || regionalDirty())&&!force){message('cardStatus','Сохраните правки или нажмите «Отменить правки», прежде чем открывать другую карточку.',true);return;}
    const request=++cardRequest,generation=epoch;
    const summary = db.leads.find(row => row.id === id);
    if (summary && current?.id !== id) {
      clearRegionalCard();
      current = { id };
      $('company').textContent = summary.name;
      $('companyMeta').textContent = [summary.city,summary.profile,summary.stage].filter(Boolean).join(' · ');
      $('cardFacts').textContent = 'Загружаю актуальные поля карточки…';
      for (const key of ['contacts','history','cardAudit']) $(key).replaceChildren();
      edit.reset();
      activity.reset();
      $('historySection').open = $('cardAuditSection').open = false;
      $('record').hidden = false;
    }
    setBusy(true);
    message('workspaceStatus','Открываю карточку…');
    try{const card=await fetchCard(id);if(request!==cardRequest||generation!==epoch)return;pending=null;$('retry').hidden=true;activity.reset();renderCard(card);message('cardStatus');message('workspaceStatus');}
    catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}
    finally{if(generation===epoch&&request===cardRequest)setBusy(false);}
  }
  function setWorkspaceData(result) {
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
      const method = fast && operation.method === 'crmSave' ? 'crmSaveFast' : operation.method;
      const result = await rpc(method,...operation.args);
      if(generation!==epoch)return;
      const id=operation.args[0];
      if (result?.conflict === true && validCanonical(result, operation.args)) {
        throw new Error('CRM_CONFLICT: Карточку уже изменили. Перечитайте её перед новым сохранением.');
      }
      if (result?.saved !== true || result.operationId !== operation.args.at(-1) ||
          (method === 'crmSaveFast' && !validCanonical(result, operation.args))) throw uncertain();
      if (method === 'crmSaveFast') {
        renderCard({ ...current, ...result.card });
      } else {
        const card=await fetchCard(id);
        if(generation!==epoch)return;
        const reopenHistory = $('historySection').open;
        activity.reset();
        renderCard(card);
        $('historySection').open = reopenHistory;
      }
      pending = null;
      message('workspaceStatus');message('cardStatus','Сохранено в CRM и журнале.');
    }catch(error){
      if(generation!==epoch)return;
      if(error.network){
        pending = operation;
        $('recovery').hidden=false;
        const target=db.leads.find(row=>row.id===operation.args[0]);
        message('workspaceStatus','Не удалось подтвердить сохранение'+(target?' «'+target.name+'»':'')+'. Проверьте результат, затем подтвердите сохранение.',true);
        message('cardStatus','До подтверждения сохранения форма временно недоступна.',true);
      }else{
        pending=null;
        message('workspaceStatus',error.message,true);message('cardStatus',error.message,true);
      }
    }finally{if(generation===epoch)setBusy(false);}
  }
  async function recoverPending() {
    if(busy||!pending)return;
    const generation=epoch,operation=pending;
    setBusy(true);message('workspaceStatus','Проверяю сохранённые данные…');
    try{
      const card=await fetchCard(operation.args[0]);
      if(generation!==epoch)return;
      const draft = current?.id === card.id
        ? Object.fromEntries(keys.map(key => [key,edit.elements[key].value])) : null;
      renderCard(card);
      if (draft && operation.method === 'crmSave') {
        for (const key of Object.keys(operation.args[2])) edit.elements[key].value = draft[key];
      }
      $('retry').hidden=false;
      message('workspaceStatus','Сохранённые данные «'+card.name+'» загружены. Подтвердите сохранение: уже записанное касание не продублируется.');
      message('cardStatus','Проверьте сохранённые значения и историю общения.');
    }catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}
    finally{if(generation===epoch)setBusy(false);}
  }
  edit.addEventListener('submit',event=>{event.preventDefault();if(!current?.fields||pending||busy||moves.has(current.id))return;const patch={};for(const key of keys)if(edit.elements[key].value!==current.fields[key])patch[key]=edit.elements[key].value;if(!Object.keys(patch).length){message('cardStatus','Изменений нет.');return;}mutate({method:'crmSave',args:[current.id,current.version,patch,uuid()]});});
  activity.addEventListener('submit',event=>{event.preventDefault();if(!current?.fields||pending||busy||moves.has(current.id))return;if(dirty()){message('cardStatus','Сначала сохраните правки карточки.',true);return;}mutate({method:'crmRecord',args:[current.id,{channel:activity.elements.channel.value,result:activity.elements.result.value,note:activity.elements.note.value},uuid()]});});
  $('retry').addEventListener('click',()=>{if(pending)mutate(pending);});
  $('recover').addEventListener('click',recoverPending);
  $('reloadCard').addEventListener('click',()=>{if(!current)return;if(dirty()&&!pending){message('cardStatus','Нажмите «Отменить правки», чтобы загрузить сохранённую версию. Текст остаётся в форме.',true);return;}loadCard(current.id,true);});
  $('discard').addEventListener('click',()=>{if(!current||busy)return;loadCard(current.id,true);});
  function uncertain() {
    return Object.assign(new Error('CRM не подтвердила результат записи.'), { network:true });
  }
  function validCanonical(result, args) {
    const card = result?.card;
    return result?.operationId === args.at(-1) && card?.id === args[0] &&
      typeof card.version === 'string' && card.version.length > 0 &&
      keys.every(key => typeof card.fields?.[key] === 'string') &&
      db.stages.includes(card.fields.stage);
  }
  function renderMoveRetries() {
    const buttons = [...moves.values()].filter(move => move.state === 'unknown').map(move => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Подтвердить этап · ' + move.lead.name;
      button.addEventListener('click',() => queueMove(move));
      return button;
    });
    $('moveRetry').replaceChildren(...buttons);
    $('moveRetry').hidden = !buttons.length;
  }
  function queueMove(move) {
    move.state = 'waiting';
    message('moveStatus','Сохраняется этап…');
    renderMoveRetries();
    renderResults();
    const generation = epoch;
    moveQueue = moveQueue.then(async () => {
      if (generation !== epoch) return;
      try {
        const method = fast ? 'crmMoveFast' : 'crmMove';
        const result = await rpc(method,...move.args);
        if (fast) {
          if (!validCanonical(result, move.args) || !(result.saved === true || result.conflict === true)) throw uncertain();
          moves.delete(move.lead.id);
          applyCanonical(result.card);
          const changed = result.card.fields.stage !== move.args[2];
          message('moveStatus',result.conflict ? 'Этап уже изменён. Показано актуальное состояние.' :
            changed ? 'Перенос записан. Показан текущий этап карточки.' : 'Этап сохранён.',result.conflict);
        } else {
          if (result?.saved !== true || result.operationId !== move.args.at(-1)) throw uncertain();
          const card = await fetchCard(move.lead.id);
          moves.delete(move.lead.id);
          applyCanonical(card);
          message('moveStatus','Этап сохранён.');
        }
      } catch (error) {
        if (generation !== epoch) return;
        if (error.network) {
          move.state = 'unknown';
          message('moveStatus','Этап не подтверждён. Подтвердите ту же операцию.',true);
        } else {
          moves.delete(move.lead.id);
          move.lead.stage = move.originalStage;
          if (!fast && error.message.startsWith('CRM_CONFLICT:')) {
            try { const card = await fetchCard(move.lead.id); if (generation === epoch) applyCanonical(card); } catch { /* The original stage is still visible. */ }
          }
          message('moveStatus',error.message,true);
        }
      } finally {
        if (generation === epoch) {
          renderMoveRetries();
          renderMetrics();
          renderResults();
          setBusy(busy);
        }
      }
    });
  }
  function moveTo(id, stage) {
    const lead = db?.leads.find(row => row.id === id);
    if (!lead || !db.stages.includes(stage) || lead.stage === stage || moves.has(id) ||
        (current?.id === id && (dirty() || pending || activity.elements.note.value))) return;
    const move = { lead, originalStage:lead.stage, args:[id,lead.version,stage,uuid()] };
    moves.set(id,move);
    lead.stage = stage;
    queueMove(move);
    setBusy(busy);
  }
  let gesture, suppressClick = false;
  const results = $('results');
  results.addEventListener('click',event => {
    if (suppressClick) { event.preventDefault(); return; }
    const button = event.target.closest('button[data-id]');
    if (button) loadCard(button.dataset.id);
  });
  function stopGesture(event, drop = false) {
    if (!gesture || (event?.pointerId !== undefined && event.pointerId !== gesture.pointer)) return;
    const { pointer, button, column, preview } = gesture;
    const target = drop ? columnAt(event) : null;
    gesture = null;
    column?.classList.remove('drop-target');
    preview?.remove();
    document.body.classList.remove('board-dragging');
    if (results.hasPointerCapture(pointer)) results.releasePointerCapture(pointer);
    if (!preview) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; },0);
    if (target) moveTo(button.dataset.id,target.dataset.stage);
  }
  function columnAt(event) {
    const column = document.elementFromPoint(event.clientX,event.clientY)?.closest('.column');
    return column && results.contains(column) && db?.stages.includes(column.dataset.stage) ? column : null;
  }
  results.addEventListener('pointerdown',event => {
    const button = event.target.closest('.draggable');
    if (!button || event.button !== 0 || event.pointerType !== 'mouse' || !canEdit() || moves.has(button.dataset.id) ||
        (current?.id === button.dataset.id && (dirty() || busy || pending || activity.elements.note.value))) return;
    gesture = { pointer:event.pointerId, button, x:event.clientX, y:event.clientY };
  });
  window.addEventListener('pointermove',event => {
    if (!gesture || gesture.pointer !== event.pointerId) return;
    if (!gesture.preview && Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y) < 7) return;
    if (!gesture.preview) {
      results.setPointerCapture(event.pointerId);
      gesture.preview = document.createElement('div');
      gesture.preview.className = 'pointer-preview';
      gesture.preview.textContent = gesture.button.querySelector('strong').textContent;
      document.body.append(gesture.preview);
      document.body.classList.add('board-dragging');
    }
    gesture.preview.style.left = Math.max(4,Math.min(event.clientX+14,innerWidth-245))+'px';
    gesture.preview.style.top = Math.max(4,event.clientY-35)+'px';
    const board = results.querySelector('.board');
    const bounds = board?.getBoundingClientRect();
    if (bounds && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      if (event.clientX > bounds.right-45) board.scrollLeft += 22;
      else if (event.clientX < bounds.left+45) board.scrollLeft -= 22;
    }
    gesture.column?.classList.remove('drop-target');
    gesture.column = columnAt(event);
    gesture.column?.classList.add('drop-target');
  });
  window.addEventListener('pointerup',event => stopGesture(event,true));
  window.addEventListener('pointercancel',event => stopGesture(event));
  results.addEventListener('lostpointercapture',event => stopGesture(event));
  window.addEventListener('blur',() => stopGesture());
  window.addEventListener('keydown',event => { if (event.key === 'Escape') stopGesture(); });
  for(const id of ['search','stageFilter','managerFilter','dueFilter','qualificationFilter'])$(id).addEventListener(id==='search'?'input':'change',renderResults);
  async function setMode(value) {
    mode=value;
    storage(modeKey,value);
    for(const name of ['list','board','queue','audit'])$(name+'Mode').setAttribute('aria-pressed',name===value);
    $('layout').hidden=value==='audit';$('auditPanel').hidden=value!=='audit';
    if(value==='audit'){const generation=epoch;message('workspaceStatus','Читаю журнал…');try{const entries=await rpc('crmAuditList');if(generation!==epoch || mode !== 'audit')return;auditEntries($('auditEntries'),entries,true);message('workspaceStatus');}catch(error){if(generation===epoch)message('workspaceStatus',error.message,true);}}
    else { if ($('workspaceStatus').textContent === 'Читаю журнал…') message('workspaceStatus'); renderResults(); }
  }
  for(const name of ['list','board','queue','audit'])$(name+'Mode').addEventListener('click',()=>setMode(name));
  $('refresh').addEventListener('click',async()=>{
    if(busy)return;
    if(dirty()||pending||activity.elements.note.value||regionalDirty()){message('cardStatus','Сначала завершите правки карточки.',true);return;}
    const generation=epoch,id=current?.id ?? null;
    setBusy(true);message('workspaceStatus','Обновляю…');
    try{
      const snapshot = await requestRefresh(id);
      if(generation!==epoch)return;
      const { data, card } = snapshot ?? {};
      if (!data || !['leads','stages','priorities','actions','outcomes'].every(key => Array.isArray(data[key])) ||
          (card !== null && (id === null || card?.id !== id || !Array.isArray(card?.links) ||
            !keys.every(key => typeof card?.fields?.[key] === 'string')))) {
        throw new Error('CRM вернула неполные данные.');
      }
      cardRequest += 1;
      if (id && card === null) {
        current = null;
        $('record').hidden = true;
        for (const key of ['contacts','history','cardAudit']) $(key).replaceChildren();
        edit.reset();
        activity.reset();
      }
      setWorkspaceData(data);
      if (card) renderCard(card);
      message('workspaceStatus',id && card === null ? 'Список обновлён. Открытой карточки больше нет в CRM.' : '');
      message('cardStatus');
    }catch(error){
      if(generation===epoch)message('workspaceStatus','Не удалось обновить список. Показаны прежние данные. Нажмите «Обновить» ещё раз.',true);
    }
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
      storage(storageKey,result.token);
      await restoreWorkspace(result.token);
    }catch(error){if(generation===epoch)message('loginStatus',error.message,true);}finally{button.disabled=false;}
  });
  async function restoreWorkspace(token) {
    const generation = epoch;
    $('resume').hidden = true;
    $('requestCode').hidden = $('verifyCode').hidden = true;
    message('loginStatus','Загружаю кабинет…');
    session = { token };
    try {
      let workspace;
      try {
        workspace = await rpc('crmWorkspace');
        if (!workspace?.session || !Array.isArray(workspace?.data?.leads)) throw new Error('Ответ CRM неполный.');
        fast = true;
      } catch (error) {
        if (error.message !== 'Неверный запрос.') throw error;
        fast = false;
        workspace = { session:await rpc('crmSession'), data:await rpc('crmList') };
      }
      if (generation !== epoch) return;
      Object.assign(session,workspace.session);
      setWorkspaceData(workspace.data);
      $('identity').textContent=session.email+' · '+roleLabel(session.role);
      $('admin').hidden=session.role!=='admin';
      $('crmSheet').hidden=session.role!=='admin';
      if(session.sheetUrl)$('crmSheet').href=session.sheetUrl;
      $('login').hidden=true;
      $('workspace').hidden=false;
      $('regionalAssign').hidden=session.role!=='admin';
      $('release').textContent=workspace.data.release || config?.release || '';
      message('workspaceStatus');
      const lastMode = storage(modeKey);
      setMode(['list','board','queue','audit'].includes(lastMode) ? lastMode : 'list');
    } catch (error) {
      if (generation !== epoch) return;
      message('loginStatus','Не удалось загрузить CRM. Повторите загрузку.',true);
      $('resume').hidden = false;
    }
  }
  $('resume').addEventListener('click',() => {
    if (session?.token) restoreWorkspace(session.token);
  });
  $('metrics').after($('regionalWorkspaceTemplate').content.cloneNode(true));
  $('cardAuditSection').after($('regionalCardTemplate').content.cloneNode(true));
  const regionalWrites = new Map();
  let regionalSurvey = null, regionalPreview = null;

  function regionalValues(form) { return Object.fromEntries(new FormData(form)); }
  function regionalDirty() {
    const survey = regionalSurvey?.id === current?.id && regionalSurvey;
    return Boolean(survey && JSON.stringify(regionalValues($('regionalSurveyForm'))) !== JSON.stringify(survey.values)) ||
      ['regionalActionForm','regionalSaleForm'].some(id=>Array.from($(id).elements).some(field=>
        ['INPUT','TEXTAREA'].includes(field.tagName) && field.value !== field.defaultValue));
  }
  function clearRegionalCard() {
    regionalSurvey = null;
    $('regionalSurveyFields').replaceChildren();
    $('regionalSurveyForm').querySelector('button').disabled = true;
    for (const id of ['regionalSurvey','regionalAction','regionalSale']) {
      $(id).open = false;
      message(id+'Status');
    }
    for (const id of ['regionalActionForm','regionalSaleForm']) $(id).reset();
    for (const id of ['regionalActionForm','regionalSaleForm']) $(id).querySelector('button').disabled=false;
  }
  function clearRegionalWorkspace() {
    clearRegionalCard();
    regionalWrites.clear();
    regionalPreview = null;
    $('regionalAssign').hidden = $('regionalAssignConfirm').hidden = true;
    for (const id of ['regionalGuide','regionalReport','regionalAssign']) {
      $(id).open = false;
      message(id+'Status');
    }
    for (const id of ['regionalGuideItems','regionalReportData']) $(id).replaceChildren();
    $('regionalReportForm').elements.staff.replaceChildren(new Option('Все сотрудники',''));
    $('regionalAssignForm').elements.target.replaceChildren();
    for (const field of $('regionalAssignForm').querySelectorAll('select')) field.disabled=false;
  }
  async function regionalWrite(method, args) {
    const payload = JSON.stringify([method,args]);
    const existing = regionalWrites.get(method);
    if (existing && existing.payload !== payload) throw new Error('Сначала повторите предыдущую запись с прежними полями.');
    const operation = existing || {payload,id:uuid()};
    const generation = epoch;
    regionalWrites.set(method,operation);
    try {
      const result=await rpc(method,...args,operation.id);
      regionalWrites.delete(method);
      return result;
    } catch (error) {
      if (generation === epoch && !error.network) regionalWrites.delete(method);
      throw error;
    }
  }
  function regionalText(tag,text) {
    const node=document.createElement(tag);
    node.textContent=text;
    return node;
  }
  async function loadRegionalGuide() {
    const generation=epoch;
    try {
      const guide=await rpc('crmManagerGuide');
      if (generation!==epoch) return;
      $('regionalGuideItems').replaceChildren(...guide.rows.filter(([label])=>label!=='revision')
        .map(([label,text])=>{
          if (!/^https:\/\/locanilia377-commits\.github\.io\/fiverox-astrakhan-market-2026\//.test(text)) return regionalText('p',label+' · '+text);
          const link=regionalText('a',label);
          link.href=text;
          const item=document.createElement('p');item.append(link);return item;
        }));
      $('regionalAssign').hidden=!guide.canAssign;
      fillSelect($('regionalAssignForm').elements.target,guide.staff,'Выберите сотрудника');
      message('regionalGuideStatus');
    } catch (error) {
      if (generation===epoch) message('regionalGuideStatus',error.message,true);
    }
  }
  $('regionalGuide').addEventListener('toggle',()=>{if (session && $('regionalGuide').open) loadRegionalGuide();});
  $('regionalAssign').addEventListener('toggle',()=>{if (session?.role==='admin' && $('regionalAssign').open) loadRegionalGuide();});

  function renderRegionalSurvey(survey) {
    regionalSurvey=survey;
    const sections=survey.sections.map(section=>{
      const box=document.createElement('fieldset'), fields=document.createElement('div');
      fields.className='grid';
      box.append(regionalText('legend',section.title),fields);
      for (const [key,title,kind,hint] of section.fields) {
        const label=regionalText('label',title);
        const field=document.createElement(kind==='notes'?'textarea':kind==='category'?'select':'input');
        if (kind==='category') field.append(new Option('—',''),...['A','B','C'].map(value=>new Option(value,value)));
        if (field.tagName==='INPUT') {
          field.type=['date','datetime-local','tel'].includes(kind)?kind:'text';
          field.maxLength=500;
          if (kind==='integer' || kind==='decimal') field.inputMode=kind==='integer'?'numeric':'decimal';
        }
        if (kind==='notes') {field.rows=2;field.maxLength=1500;}
        field.name=key;
        field.value=survey.values[key];
        if (hint && field.tagName!=='SELECT') field.placeholder=hint;
        label.append(field);
        fields.append(label);
      }
      return box;
    });
    $('regionalSurveyFields').replaceChildren(...sections);
    $('regionalSurveyForm').querySelector('button').disabled=false;
  }
  $('regionalSurvey').addEventListener('toggle',async()=>{
    if (!$('regionalSurvey').open || !current?.fields || regionalSurvey?.id===current.id) return;
    const generation=epoch,id=current.id;
    message('regionalSurveyStatus','Открываю анкету…');
    try {
      const survey=await rpc('crmSurveyRead',id);
      if (generation!==epoch || current?.id!==id) return;
      renderRegionalSurvey(survey);
      message('regionalSurveyStatus');
    } catch (error) {
      if (generation===epoch && current?.id===id) message('regionalSurveyStatus',error.message,true);
    }
  });
  $('regionalSurveyForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const form=event.currentTarget,id=current?.id,generation=epoch;
    if (!regionalSurvey || regionalSurvey.id!==id || !canEdit()) return;
    const button=form.querySelector('button');button.disabled=true;
    try {
      const update=await regionalWrite('crmSurveySave',[id,regionalSurvey.revision,regionalValues(form)]);
      if (generation===epoch && current?.id===id) {
        renderRegionalSurvey({...regionalSurvey,...update});
        message('regionalSurveyStatus','Анкета сохранена.');
      }
    } catch (error) {
      if (generation===epoch && current?.id===id) message('regionalSurveyStatus',error.message,true);
    } finally {if (generation===epoch && current?.id===id) button.disabled=false;}
  });
  for (const [id,method,text] of [
    ['regionalAction','crmRegionalEventSave','Действие сохранено.'],
    ['regionalSale','crmRegionalSaleSave','Продажа сохранена.'],
  ]) {
    $(id+'Form').addEventListener('submit',async event=>{
      event.preventDefault();
      if (!current?.fields || !canEdit()) return;
      const form=event.currentTarget,generation=epoch,leadId=current.id, data=regionalValues(form);
      if (id==='regionalSale') {
        data.quantity=Number(data.quantity);
        data.unitPrice=Number(data.unitPrice);
      }
      const button=form.querySelector('button');button.disabled=true;
      try {
        await regionalWrite(method,[{leadId,...data}]);
        if (generation===epoch && current?.id===leadId) {form.reset();message(id+'Status',text);}
      } catch (error) {
        if (generation===epoch && current?.id===leadId) message(id+'Status',error.message,true);
      } finally {if (generation===epoch && current?.id===leadId) button.disabled=false;}
    });
  }
  const regionalReportForm=$('regionalReportForm');
  regionalReportForm.elements.period.addEventListener('change',()=>{
    const custom=regionalReportForm.elements.period.value==='custom';
    for (const key of ['from','to']) {
      regionalReportForm.elements[key].closest('label').hidden=!custom;
      regionalReportForm.elements[key].required=custom;
    }
  });
  async function loadRegionalReport() {
    const generation=epoch,button=regionalReportForm.querySelector('button');
    if (!session || button.disabled) return;
    button.disabled=true;
    message('regionalReportStatus','Готовлю отчёт…');
    try {
      const data=await rpc('crmManagerReport',regionalValues(regionalReportForm));
      if (generation!==epoch) return;
      const staff=regionalReportForm.elements.staff, selected=staff.value;
      staff.replaceChildren(new Option('Все сотрудники',''),...data.staff.map(person=>new Option(person.name,person.email)));
      staff.value=Array.from(staff.options).some(option=>option.value===selected)?selected:'';
      const {totals,funnel,monthly,retention,completeness,period}=data;
      $('regionalReportData').replaceChildren(
        regionalText('p',dateLabel(period.from)+' – '+dateLabel(period.to)),
        regionalText('p','Касания '+totals.contacts+' · Визиты '+totals.visits+' · Тесты '+totals.tests+' · Продажи '+totals.sales+' · Выручка '+totals.revenue.toLocaleString('ru-RU')+' ₽'),
        regionalText('p','Воронка: касание '+funnel.contacted+' · тест '+funnel.tested+' · покупка '+funnel.sold),
        regionalText('p','За месяц: тесты '+monthly.tests+' · клиенты с тестом '+monthly.tested+' · покупатели '+monthly.sold),
        regionalText('p','Повторные покупки за '+retention.days+' дней: '+retention.repeated+' из '+retention.mature+' клиентов с завершённым окном'),
        regionalText('p','Карточки '+data.clients.length+' · поля анкет '+completeness.filled),
        ...data.clients.map(item=>regionalText('p',item.name+' · '+item.city+' · '+item.id+' · '+dateLabel(item.last)+' · '+item.revenue.toLocaleString('ru-RU')+' ₽')));
      message('regionalReportStatus');
    } catch (error) {
      if (generation===epoch) message('regionalReportStatus',error.message,true);
    } finally {button.disabled=false;}
  }
  regionalReportForm.addEventListener('submit',event=>{event.preventDefault();loadRegionalReport();});
  $('regionalReport').addEventListener('toggle',()=>{if ($('regionalReport').open) loadRegionalReport();});

  const regionalAssignForm=$('regionalAssignForm'), regionalConfirm=$('regionalAssignConfirm');
  regionalAssignForm.addEventListener('change',()=>{
    if (!regionalWrites.has('crmBulkAssign')) {
      regionalPreview=null;
      regionalConfirm.hidden=true;
    }
  });
  regionalAssignForm.addEventListener('submit',async event=>{
    event.preventDefault();
    if (regionalWrites.has('crmBulkAssign')) return;
    const generation=epoch,{target,area}=regionalValues(regionalAssignForm);
    regionalPreview=null;regionalConfirm.hidden=true;
    try {
      const preview=await rpc('crmAssignmentPreview',target,area);
      if (generation!==epoch || regionalAssignForm.elements.target.value!==target || regionalAssignForm.elements.area.value!==area) return;
      regionalPreview={target,area,revision:preview.revision};
      regionalConfirm.hidden=preview.changed===0;
      message('regionalAssignStatus','Точек '+preview.total+' · изменятся '+preview.changed+' · смена ответственного '+preview.reassigned+'.');
    } catch (error) {
      if (generation===epoch) message('regionalAssignStatus',error.message,true);
    }
  });
  regionalConfirm.addEventListener('click',async()=>{
    if (!regionalPreview || session?.role!=='admin') return;
    const generation=epoch,{target,area,revision}=regionalPreview;
    const selectors=[regionalAssignForm.elements.target,regionalAssignForm.elements.area];
    regionalConfirm.disabled=true;selectors.forEach(field=>field.disabled=true);
    try {
      const result=await regionalWrite('crmBulkAssign',[target,area,revision]);
      if (generation!==epoch) return;
      regionalPreview=null;regionalConfirm.hidden=true;
      message('regionalAssignStatus','Назначено точек: '+result.changed+'. Операция записана в журнал.');
      if (!regionalDirty()) $('refresh').click();
    } catch (error) {
      if (generation===epoch) message('regionalAssignStatus',error.message,true);
    } finally {
      regionalConfirm.disabled=false;
      if (!regionalWrites.has('crmBulkAssign')) selectors.forEach(field=>field.disabled=false);
    }
  });

  const rememberedToken = storage(storageKey);
  if (rememberedToken) restoreWorkspace(rememberedToken);
  window.addEventListener('beforeunload',event=>{if(session&&(dirty()||pending||moves.size||activity.elements.note.value||regionalDirty()||regionalWrites.size)){event.preventDefault();event.returnValue='';}});
})();
