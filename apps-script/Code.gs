const CRM = Object.freeze({
  sheetId: 'YOUR_PRIVATE_CRM_SPREADSHEET_ID',
  release: 'astrakhan-cabinet-2026-11-11-r1',
  stages: ['Не обработан', 'Контакт установлен', 'Потребность выявлена', 'КП отправлено', 'Переговоры', 'Клиент', 'Отложено', 'Отказ'],
  priorities: ['Не задан', 'Высокий', 'Средний', 'Низкий'],
  actions: ['Звонок', 'WhatsApp', 'Telegram', 'Email', 'Встреча', 'Другое'],
  outcomes: ['Состоялся', 'Нет ответа', 'Перезвонить', 'Отказ'],
  firstRow: 5, lastRow: 504,
  auditTab: 'Журнал CRM', operationsTab: 'Операции CRM',
  fields: {
    stage: { col: 3, label: 'Этап', kind: 'stage' },
    manager: { col: 4, label: 'Ответственный', kind: 'text', max: 254 },
    priority: { col: 5, label: 'Приоритет', kind: 'priority' },
    next: { col: 6, label: 'Следующее действие', kind: 'text', max: 500 },
    due: { col: 7, label: 'Срок действия', kind: 'date' },
    amount: { col: 11, label: 'План первой сделки', kind: 'amount' },
    closeDate: { col: 12, label: 'План закрытия', kind: 'date' },
    purchaseDate: { col: 13, label: 'Дата первой покупки', kind: 'date' },
    purchaseAmount: { col: 14, label: 'Сумма первой покупки', kind: 'amount' },
    reason: { col: 15, label: 'Причина отказа', kind: 'text', max: 500 },
    note: { col: 16, label: 'Комментарий', kind: 'text', max: 3000 },
    contact: { col: 21, label: 'Контактное лицо', kind: 'text', max: 254 },
    position: { col: 22, label: 'Должность', kind: 'text', max: 254 }
  }
});

function checkAstrakhanPermissions() {
  const info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
  console.info(JSON.stringify({ status: String(info.getAuthorizationStatus()), scopes: info.getAuthorizedScopes() }));
}

function authorizeAstrakhanMail() {
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, ['https://www.googleapis.com/auth/script.send_mail']);
  console.info('Отправка кодов разрешена. Остаток квоты: ' + MailApp.getRemainingDailyQuota());
}

function setupAstrakhanCrm() {
  const book = crmRawBook_();
  const owner = book.getOwner().getEmail().trim().toLowerCase();
  if (Session.getActiveUser().getEmail().trim().toLowerCase() !== owner) throw new Error('Настройку выполняет владелец таблицы.');
  Sheets.Spreadsheets.get(book.getId(), { fields: 'spreadsheetId' });
  const headers = {};
  headers[CRM.auditTab] = ['Время МСК', 'Автор', 'Действие', 'ID точки', 'Компания', 'Изменения до и после', 'ID операции'];
  headers[CRM.operationsTab] = ['ID операции', 'Автор', 'ID точки', 'Действие', 'Хеш запроса', 'Время МСК', 'Результат'];
  Object.keys(headers).forEach(name => {
    let sheet = book.getSheetByName(name);
    if (!sheet) sheet = book.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, headers[name].length).setValues([headers[name]]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers[name].length).setFontWeight('bold').setBackground('#f1f3f4');
    sheet.setColumnWidths(1, headers[name].length, 180);
    if (name === CRM.operationsTab && !sheet.isSheetHidden()) sheet.hideSheet();
  });
  const auth = crmEmailSetup_();
  console.info('CRM Астрахани настроена. Вход по коду включён. Остаток почтовой квоты: ' + auth.remainingMailRecipients);
  return { release: CRM.release, configured: auth.enabled };
}

function crmRawBook_() { return SpreadsheetApp.openById(CRM.sheetId); }
function crmContext_(token, role) { return crmEmailIdentity_(token, role || 'viewer'); }
function crmHash_(value) { return crmEmailDigest_(JSON.stringify(value)); }
function crmTime_() { return Utilities.formatDate(new Date(), 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss'); }
function crmDate_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Europe/Moscow', 'yyyy-MM-dd');
  return value === '' ? '' : String(value);
}
function crmDateInput_(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Проверьте дату.');
  const date = Utilities.parseDate(value, 'Europe/Moscow', 'yyyy-MM-dd');
  if (crmDate_(date) !== value) throw new Error('Проверьте календарную дату.');
  return date;
}
function crmStringCell_(value) { return { userEnteredValue: { stringValue: String(value) } }; }
function crmCell_(value) {
  if (value === '') return {};
  if (value instanceof Date) {
    const local = Utilities.formatDate(value, 'Europe/Moscow', "yyyy-MM-dd'T'HH:mm:ss'Z'");
    return { userEnteredValue: { numberValue: (Date.parse(local) - Date.UTC(1899, 11, 30)) / 86400000 } };
  }
  return typeof value === 'number' ? { userEnteredValue: { numberValue: value } } : crmStringCell_(value);
}
function crmWithLock_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) throw new Error('CRM занята другим сохранением. Повторите запрос с тем же номером операции.');
  try { return action(); } finally { lock.releaseLock(); }
}
function crmFind_(book, id) {
  if (typeof id !== 'string' || !/^(Y-)?\d{1,24}$/.test(id)) throw new Error('Некорректный ID точки.');
  const sheet = book.getSheetByName('CRM');
  const found = sheet.getRange(CRM.firstRow, 1, CRM.lastRow - CRM.firstRow + 1, 1).createTextFinder(id).matchEntireCell(true).findAll();
  if (found.length !== 1) throw new Error('Точка не найдена или её ID дублируется.');
  return { sheet: sheet, row: found[0].getRow() };
}
function crmFields_(row) {
  const fields = {};
  Object.keys(CRM.fields).forEach(key => {
    const spec = CRM.fields[key], value = row[spec.col - 1];
    fields[key] = spec.kind === 'date' ? crmDate_(value) : value === '' ? '' : String(value);
  });
  return fields;
}
function crmVersion_(id, row) { return crmHash_([id, crmFields_(row)]); }
function crmSession(token) {
  const access = crmContext_(token);
  return { email: access.email, role: access.role, method: 'email', release: CRM.release,
    sheetUrl: access.role === 'admin' ? 'https://docs.google.com/spreadsheets/d/' + CRM.sheetId + '/edit' : '' };
}
function crmList(token) {
  const access = crmContext_(token);
  const rows = access.book.getSheetByName('CRM').getRange(5, 1, 500, 23).getValues();
  return {
    release: CRM.release, today: crmDate_(new Date()), stages: CRM.stages,
    priorities: CRM.priorities, actions: CRM.actions, outcomes: CRM.outcomes,
    leads: rows.filter(row => row[0]).map(row => ({
      id: String(row[0]), name: String(row[1]), stage: String(row[2]),
      manager: String(row[3]), priority: String(row[4]), next: String(row[5]), due: crmDate_(row[6]),
      qualification: String(row[17]), city: String(row[18]), profile: String(row[19]),
      version: crmVersion_(String(row[0]), row)
    }))
  };
}
function crmReadWith_(access, id) {
  const card = crmFind_(access.book, id);
  const row = card.sheet.getRange(card.row, 1, 1, 23).getValues()[0];
  const base = access.book.getSheetByName('База').getRange(5, 1, 995, 35).getValues().filter(item => String(item[0]) === id);
  if (base.length !== 1) throw new Error('Проверьте ID в исходной базе.');
  const details = base[0];
  const history = access.book.getSheetByName('Касания').getRange(5, 1, 500, 8).getValues()
    .filter(item => String(item[1]) === id && item[0] instanceof Date)
    .sort((a, b) => b[0].getTime() - a[0].getTime()).slice(0, 30)
    .map(item => ({ at: Utilities.formatDate(item[0], 'Europe/Moscow', 'dd.MM.yyyy HH:mm') + ' МСК', actor: String(item[3]), channel: String(item[4]), result: String(item[5]), note: String(item[6]), check: String(item[7]) }));
  const auditSheet = access.book.getSheetByName(CRM.auditTab);
  const audit = auditSheet && auditSheet.getLastRow() > 1 ? auditSheet.getRange(2, 1, auditSheet.getLastRow() - 1, 7).getDisplayValues()
    .filter(item => item[3] === id).slice(-30).reverse().map(item => {
      let changes = [];
      try { changes = JSON.parse(item[5]); } catch (error) { /* A direct Sheets editor may have changed a journal cell. */ }
      return { at: item[0] + ' МСК', actor: item[1], action: item[2], changes: changes };
    }) : [];
  return {
    id: id, name: String(row[1]), city: String(row[18]), address: String(details[4]),
    profile: String(row[19]), qualification: String(row[17]), phones: String(details[8]),
    email: String(details[9]), websites: String(details[10]), socials: String(details[11]),
    links: [String(details[14]), String(details[15])], fields: crmFields_(row),
    lastContact: crmDate_(row[8]), contacts: row[9] || 0, check: String(row[7]),
    version: crmVersion_(id, row), history: history, audit: audit
  };
}
function crmRead(token, id) { return crmReadWith_(crmContext_(token), id); }
function crmAuditList(token) {
  const access = crmContext_(token);
  const sheet = access.book.getSheetByName(CRM.auditTab);
  if (!sheet || sheet.getLastRow() < 2) return [];
  const count = Math.min(100, sheet.getLastRow() - 1);
  return sheet.getRange(sheet.getLastRow() - count + 1, 1, count, 7).getDisplayValues().reverse().map(row => {
    let changes = [];
    try { changes = JSON.parse(row[5]); } catch (error) { /* Preserve readable journal metadata. */ }
    return { at: row[0] + ' МСК', actor: row[1], action: row[2], id: row[3], name: row[4], changes: changes };
  });
}
function crmValidate_(key, value) {
  const spec = CRM.fields[key];
  if (!spec || typeof value !== 'string') throw new Error('Недопустимое поле карточки.');
  if (spec.kind === 'stage' && !CRM.stages.includes(value)) throw new Error('Выберите этап из списка.');
  if (spec.kind === 'priority' && !CRM.priorities.includes(value)) throw new Error('Выберите приоритет из списка.');
  if (spec.kind === 'date') return crmDateInput_(value);
  if (spec.kind === 'amount') {
    if (value === '') return '';
    if (!/^\d+(?:\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value)) || Number(value) > 1e12) throw new Error('Введите неотрицательную сумму с точностью до копеек.');
    return Number(value);
  }
  if (spec.kind === 'text' && value.length > spec.max) throw new Error('Слишком длинный текст в поле «' + spec.label + '».');
  return value;
}
function crmOperation_(book, actor, operationId, action, id, fingerprint) {
  if (typeof operationId !== 'string' || !/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('Нет корректного номера операции.');
  const sheet = book.getSheetByName(CRM.operationsTab);
  if (!sheet || !book.getSheetByName(CRM.auditTab)) throw new Error('Журнал CRM ещё не настроен.');
  if (sheet.getLastRow() < 2) return null;
  const found = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).createTextFinder(operationId).matchEntireCell(true).findAll();
  if (found.length > 1) throw new Error('Повтор ID в журнале операций.');
  if (!found.length) return null;
  const row = sheet.getRange(found[0].getRow(), 1, 1, 7).getDisplayValues()[0];
  if (row[1] !== actor || row[2] !== id || row[3] !== action || row[4] !== fingerprint) throw new Error('Этот номер операции уже использован для другого запроса.');
  return JSON.parse(row[6]);
}
function crmCommit_(access, card, changes, requests, operationId, action, fingerprint, result) {
  const book = access.book, at = crmTime_();
  const audit = book.getSheetByName(CRM.auditTab), operations = book.getSheetByName(CRM.operationsTab);
  if (!audit || !operations) throw new Error('Не найден обязательный журнал. Сохранение отменено.');
  const auditValues = [at, access.email, action, card.id, card.name, JSON.stringify(changes), operationId];
  const operationValues = [operationId, access.email, card.id, action, fingerprint, at, JSON.stringify(result)];
  const append = (sheetId, values) => ({ appendCells: { sheetId: sheetId, rows: [{ values: values.map(crmStringCell_) }], fields: 'userEnteredValue' } });
  Sheets.Spreadsheets.batchUpdate({ requests: requests.concat([append(audit.getSheetId(), auditValues), append(operations.getSheetId(), operationValues)]) }, book.getId());
  return result;
}
function crmSave(token, id, version, patch, operationId) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).length > 13) throw new Error('Форма заполнена неверно.');
  const keys = Object.keys(patch).sort();
  keys.forEach(key => { if (!Object.prototype.hasOwnProperty.call(CRM.fields, key)) throw new Error('Поле не разрешено для записи.'); crmValidate_(key, patch[key]); });
  const fingerprint = crmHash_([id, version, keys.map(key => [key, patch[key]])]);
  return crmWithLock_(() => {
    const access = crmContext_(token, 'editor');
    const replay = crmOperation_(access.book, access.email, operationId, 'Правка карточки', id, fingerprint);
    if (replay) return replay;
    const found = crmFind_(access.book, id), row = found.sheet.getRange(found.row, 1, 1, 23).getValues()[0];
    if (version !== crmVersion_(id, row)) throw new Error('CRM_CONFLICT: Карточку уже изменили. Ваши правки оставлены в форме. Загрузите актуальную версию перед новым сохранением.');
    const fields = crmFields_(row), changes = [], requests = [];
    keys.forEach(key => {
      const parsed = crmValidate_(key, patch[key]);
      const after = parsed instanceof Date ? crmDate_(parsed) : parsed === '' ? '' : String(parsed);
      if (after === fields[key]) return;
      const spec = CRM.fields[key];
      if (found.sheet.getRange(found.row, spec.col).getFormula()) throw new Error('Поле содержит формулу. Обратитесь к владельцу таблицы.');
      changes.push({ field: spec.label, before: fields[key], after: after });
      requests.push({ updateCells: { start: { sheetId: found.sheet.getSheetId(), rowIndex: found.row - 1, columnIndex: spec.col - 1 }, rows: [{ values: [crmCell_(parsed)] }], fields: 'userEnteredValue' } });
      row[spec.col - 1] = parsed;
    });
    const result = { saved: true, operationId: operationId, version: crmVersion_(id, row) };
    if (!changes.length) return result;
    return crmCommit_(access, { id: id, name: String(row[1]) }, changes, requests, operationId, 'Правка карточки', fingerprint, result);
  });
}
function crmMove(token, id, version, stage, operationId) {
  return crmSave(token, id, version, { stage: stage }, operationId);
}
function crmRecord(token, id, event, operationId) {
  if (!event || !CRM.actions.includes(event.channel) || !CRM.outcomes.includes(event.result) || typeof event.note !== 'string' || event.note.length > 3000) throw new Error('Проверьте канал, результат и текст контакта.');
  const fingerprint = crmHash_([id, event.channel, event.result, event.note]);
  return crmWithLock_(() => {
    const access = crmContext_(token, 'editor');
    const replay = crmOperation_(access.book, access.email, operationId, 'Запись контакта', id, fingerprint);
    if (replay) return replay;
    const found = crmFind_(access.book, id);
    const sheet = access.book.getSheetByName('Касания');
    const rows = sheet.getRange(5, 1, 500, 8).getValues();
    const free = rows.findIndex(row => [0, 1, 3, 4, 5, 6].every(col => row[col] === ''));
    if (free < 0) throw new Error('Журнал заполнен. Владелец должен расширить диапазоны и формулы таблицы.');
    const targetRow = free + 5;
    if (!sheet.getRange(targetRow, 3).getFormula() || !sheet.getRange(targetRow, 8).getFormula()) throw new Error('В строке журнала отсутствуют расчётные формулы.');
    const change = (column, values) => ({ updateCells: { start: { sheetId: sheet.getSheetId(), rowIndex: targetRow - 1, columnIndex: column - 1 }, rows: [{ values: values.map(crmCell_) }], fields: 'userEnteredValue' } });
    const requests = [change(1, [new Date(), id]), change(4, [access.email, event.channel, event.result, event.note])];
    const changes = [{ field: 'Канал', before: '', after: event.channel }, { field: 'Результат', before: '', after: event.result }, { field: 'Суть разговора', before: '', after: event.note }];
    return crmCommit_(access, { id: id, name: found.sheet.getRange(found.row, 2).getDisplayValue() }, changes, requests, operationId, 'Запись контакта', fingerprint, { saved: true, operationId: operationId });
  });
}
function crmDiagnostics(token) {
  crmContext_(token, 'admin');
  return JSON.parse(crmEmailProps_().getProperty('CRM_AUTH_DIAGNOSTICS') || '[]');
}
function crmJson_(body) { return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return crmJson_({ service: 'FIVEROX CRM Астрахань', release: CRM.release }); }
function doPost(e) {
  const post = e && e.postData;
  if (!post || typeof post.contents !== 'string' || post.contents.length > 25000 || !/^text\/plain(?:\s*;|$)/i.test(post.type || '')) return crmJson_({ ok: false, error: 'Неверный запрос.' });
  let request;
  try { request = JSON.parse(post.contents); } catch (error) { return crmJson_({ ok: false, error: 'Неверный запрос.' }); }
  const methods = {
    crmEmailStart: [crmEmailStart, 2], crmEmailVerify: [crmEmailVerify, 3], crmEmailLogout: [crmEmailLogout, 1],
    crmSession: [crmSession, 1], crmList: [crmList, 1], crmRead: [crmRead, 2], crmSave: [crmSave, 5], crmAuditList: [crmAuditList, 1],
    crmMove: [crmMove, 5], crmRecord: [crmRecord, 4], crmDiagnostics: [crmDiagnostics, 1]
  };
  if (!request || typeof request.method !== 'string' || !Object.prototype.hasOwnProperty.call(methods, request.method) || !Array.isArray(request.args) || request.args.length !== methods[request.method][1]) return crmJson_({ ok: false, error: 'Неверный запрос.' });
  try { return crmJson_({ ok: true, result: methods[request.method][0].apply(null, request.args) }); }
  catch (error) {
    const message = error && error.message;
    return crmJson_({ ok: false, error: typeof message === 'string' && message.length < 400 ? message : 'Не удалось выполнить запрос. Перечитайте карточку перед повтором.' });
  }
}

const CRM_EMAIL_AUTH = Object.freeze({
  enabledKey: 'CRM_EMAIL_AUTH_ENABLED',
  secretKey: 'CRM_EMAIL_AUTH_SECRET',
  mailBudgetKey: 'crm.email.v1.mailBudget',
  codeTtl: 10 * 60 * 1000,
  sessionTtl: 12 * 60 * 60 * 1000,
  resendDelay: 90 * 1000,
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  maxAttempts: 5,
  maxSessions: 5,
  roles: Object.freeze({ viewer: 1, editor: 2, admin: 3 }),
  codeError: 'Код неверен, истёк или уже использован. Проверьте код или запросите новый.',
  sessionError: 'CRM_AUTH_REQUIRED: Сессия завершилась. Войдите снова.',
});

function crmEmailProps_() {
  return PropertiesService.getScriptProperties();
}

function crmEmailSecret_(props) {
  if (props.getProperty(CRM_EMAIL_AUTH.enabledKey) !== 'true') return '';
  const secret = props.getProperty(CRM_EMAIL_AUTH.secretKey);
  return /^[a-f0-9]{64}$/.test(secret || '') ? secret : '';
}

function crmEmailConfigured_() {
  return Boolean(crmEmailSecret_(crmEmailProps_()));
}

function crmEmailNormalize_(value) {
  if (typeof value !== 'string' || value.length > 254) return '';
  const email = value.trim().toLowerCase();
  const [local, domain, extra] = email.split('@');
  if (extra !== undefined || !local || !domain || local.length > 64 ||
      local.startsWith('.') || local.endsWith('.') || local.includes('..') ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) return '';
  return email;
}

function crmEmailAddress_(user) {
  return user ? crmEmailNormalize_(user.getEmail()) : '';
}

function crmEmailMailbox_(email) {
  const gmail = /^([a-z0-9.]+)@gmail\.com$/.exec(email || '');
  return gmail ? gmail[1].replace(/\./g, '') + '@gmail.com' : email;
}

function crmEmailAccess_(email) {
  const mailbox = crmEmailMailbox_(email);
  if (!mailbox) return null;
  try {
    const book = crmRawBook_();
    const owner = crmEmailAddress_(book.getOwner());
    if (!owner || owner !== crmEmailAddress_(Session.getEffectiveUser())) return null;
    const isOwner = mailbox === crmEmailMailbox_(owner);
    const address = isOwner ? owner : book.getEditors().map(crmEmailAddress_)
      .find(editor => crmEmailMailbox_(editor) === mailbox);
    return address ? { book, email: address, role: isOwner ? 'admin' : 'editor', provider: 'email', subject: address, method: 'email' } : null;
  } catch (error) {
    return null;
  }
}

function crmEmailLock_(action) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) throw new Error('Сервис входа занят. Повторите попытку.');
  try {
    return action(crmEmailProps_());
  } finally {
    lock.releaseLock();
  }
}

function crmEmailRandom_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
}

// Run in the Apps Script editor as the owner. This never sends a letter.
function crmEmailSetup_() {
  const owner = crmEmailAddress_(crmRawBook_().getOwner());
  if (!owner || owner !== crmEmailAddress_(Session.getActiveUser()) || owner !== crmEmailAddress_(Session.getEffectiveUser())) {
    throw new Error('Настроить вход может только владелец CRM-таблицы в редакторе Apps Script.');
  }
  const remainingMailRecipients = MailApp.getRemainingDailyQuota();
  crmEmailLock_(props => {
    const existing = props.getProperty(CRM_EMAIL_AUTH.secretKey);
    const secret = /^[a-f0-9]{64}$/.test(existing || '') ? existing : crmEmailRandom_();
    props.setProperties({ [CRM_EMAIL_AUTH.secretKey]: secret, [CRM_EMAIL_AUTH.enabledKey]: 'true' });
  });
  return { enabled: true, remainingMailRecipients };
}

function crmEmailHex_(bytes) {
  return bytes.map(byte => (byte & 255).toString(16).padStart(2, '0')).join('');
}

function crmEmailDigest_(value) {
  return crmEmailHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8));
}

function crmEmailHmac_(value, secret) {
  return Utilities.computeHmacSha256Signature(value, secret, Utilities.Charset.UTF_8);
}

function crmEmailEqual_(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function crmEmailUserKey_(email) {
  return crmEmailDigest_(email);
}

function crmEmailRecordKey_(key) {
  return 'crm.email.v1.user.' + key;
}

function crmEmailRecord_(props, key, email) {
  const stored = props.getProperty(crmEmailRecordKey_(key));
  return stored ? JSON.parse(stored) : { email, sent: [], challenges: [], sessions: [] };
}

function crmEmailSave_(props, key, record) {
  props.setProperty(crmEmailRecordKey_(key), JSON.stringify(record));
}

function crmEmailPrune_(record, now) {
  record.sent = record.sent.filter(time => time > now - CRM_EMAIL_AUTH.day);
  record.challenges = record.challenges.filter(challenge => challenge.expires > now);
  record.sessions = record.sessions.filter(session => session.expires > now);
}

function crmEmailSendAllowed_(times, now, hourly, daily) {
  return times.length < daily && times.filter(time => time > now - CRM_EMAIL_AUTH.hour).length < hourly;
}

function crmEmailProof_(proof) {
  return typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof) ? crmEmailDigest_(proof) : '';
}

function crmEmailCodeHash_(email, challenge, code, secret) {
  return crmEmailHex_(crmEmailHmac_(JSON.stringify(['code', email, challenge.id, challenge.proof, code]), secret));
}

function crmEmailTokenHash_(token, secret) {
  return crmEmailHex_(crmEmailHmac_('session:' + token, secret));
}

function crmEmailReserve_(props, key, email, mailbox, proof) {
  const secret = crmEmailSecret_(props);
  if (!secret) return null;
  const now = Date.now(), record = crmEmailRecord_(props, key, email);
  crmEmailPrune_(record, now);
  // Include past sends from the exact address without rewriting legacy session records.
  const legacySent = email === mailbox ? [] : crmEmailRecord_(props, crmEmailUserKey_(email)).sent
    .filter(time => time > now - CRM_EMAIL_AUTH.day);
  const sent = [...record.sent, ...legacySent];
  const last = Math.max(0, ...sent);
  const total = JSON.parse(props.getProperty(CRM_EMAIL_AUTH.mailBudgetKey) || '[]')
    .filter(time => time > now - CRM_EMAIL_AUTH.day);
  if ((last && now - last < CRM_EMAIL_AUTH.resendDelay) ||
      !crmEmailSendAllowed_(sent, now, 3, 8) || !crmEmailSendAllowed_(total, now, 25, 80)) return null;

  const challenge = { id: crmEmailRandom_(), proof, expires: now + CRM_EMAIL_AUTH.codeTtl, attempts: 0 };
  const value = crmEmailHmac_('generate:' + challenge.id, secret).slice(0, 6)
    .reduce((number, byte) => number * 256 + (byte & 255), 0) % 100000000;
  const code = String(value).padStart(8, '0');
  challenge.digest = crmEmailCodeHash_(mailbox, challenge, code, secret);
  record.email = email;
  record.sent.push(now);
  record.challenges = record.challenges.filter(item => item.proof !== proof).slice(-2);
  record.challenges.push(challenge);
  props.setProperties({
    [CRM_EMAIL_AUTH.mailBudgetKey]: JSON.stringify([...total, now]),
    [crmEmailRecordKey_(key)]: JSON.stringify(record),
  });
  return { id: challenge.id, code };
}

let crmAuthRequestId_ = '';
function crmEmailOutcome_(reason) {
  const props = crmEmailProps_();
  const diagnostic = { at: crmTime_(), requestId: crmAuthRequestId_, result: reason };
  try {
    const prior = JSON.parse(props.getProperty('CRM_AUTH_DIAGNOSTICS') || '[]');
    props.setProperty('CRM_AUTH_DIAGNOSTICS', JSON.stringify(prior.slice(-39).concat([diagnostic])));
  } catch (error) { console.warn('Could not update private mail diagnostics.'); }
  return { accepted: true, requestId: crmAuthRequestId_, resendAfter: 90 };
}

function crmEmailStart(value, browserProof) {
  crmAuthRequestId_ = Utilities.getUuid();
  const email = crmEmailNormalize_(value);
  if (!email) return crmEmailOutcome_('malformed_address');
  try {
    const proof = crmEmailProof_(browserProof);
    if (!proof) return crmEmailOutcome_('invalid_browser_proof');
    if (!crmEmailConfigured_()) return crmEmailOutcome_('not_configured');
    const access = crmEmailAccess_(email);
    if (!access) return crmEmailOutcome_('ineligible');
    if (MailApp.getRemainingDailyQuota() < 1) return crmEmailOutcome_('quota_exhausted');
    const mailbox = crmEmailMailbox_(access.email), key = crmEmailUserKey_(mailbox);
    const delivery = crmEmailLock_(props => crmEmailReserve_(props, key, access.email, mailbox, proof));
    if (!delivery) return crmEmailOutcome_('throttled');
    try {
      MailApp.sendEmail({
        to: access.email,
        name: 'FIVEROX CRM',
        subject: 'Код входа в FIVEROX CRM — Астрахань',
        body: 'Код входа в кабинет Астрахани: ' + delivery.code + '\n\nКод действует 10 минут и используется один раз. Введите его только на странице FIVEROX CRM. Если вы не запрашивали код, просто проигнорируйте письмо.',
      });
    } catch (error) {
      crmEmailOutcome_('transport_failure');
      crmEmailLock_(props => {
        const record = crmEmailRecord_(props, key, access.email);
        record.challenges = record.challenges.filter(item => item.id !== delivery.id);
        crmEmailSave_(props, key, record);
      });
      return true;
    }
    return crmEmailOutcome_('submitted');
  } catch (error) {
    return crmEmailOutcome_('internal_failure');
  }
}

function crmEmailVerify(value, browserProof, code) {
  const email = crmEmailNormalize_(value), proof = crmEmailProof_(browserProof);
  if (!email || !proof || typeof code !== 'string' || !/^\d{8}$/.test(code)) throw new Error(CRM_EMAIL_AUTH.codeError);
  const mailbox = crmEmailMailbox_(email), key = crmEmailUserKey_(mailbox), props = crmEmailProps_();
  const challenge = crmEmailRecord_(props, key, email).challenges.find(item => item.proof === proof);
  if (!crmEmailSecret_(props) || !challenge || challenge.expires <= Date.now()) throw new Error(CRM_EMAIL_AUTH.codeError);

  const result = crmEmailLock_(lockedProps => {
    const now = Date.now(), record = crmEmailRecord_(lockedProps, key, email);
    crmEmailPrune_(record, now);
    const secret = crmEmailSecret_(lockedProps), active = record.challenges.find(item => item.id === challenge.id);
    if (!secret || !active) return null;
    if (!crmEmailEqual_(active.digest, crmEmailCodeHash_(mailbox, active, code, secret))) {
      active.attempts += 1;
      if (active.attempts >= CRM_EMAIL_AUTH.maxAttempts) record.challenges = record.challenges.filter(item => item !== active);
      crmEmailSave_(lockedProps, key, record);
      return null;
    }

    record.challenges = record.challenges.filter(item => item !== active);
    const access = crmEmailAccess_(email);
    if (!access) {
      crmEmailSave_(lockedProps, key, record);
      return null;
    }
    const token = key + '.' + crmEmailRandom_();
    record.email = access.email;
    record.sessions = record.sessions.slice(1 - CRM_EMAIL_AUTH.maxSessions);
    record.sessions.push({ digest: crmEmailTokenHash_(token, secret), expires: now + CRM_EMAIL_AUTH.sessionTtl });
    crmEmailSave_(lockedProps, key, record);
    const { book, ...session } = access;
    return { token, session };
  });
  if (!result) throw new Error(CRM_EMAIL_AUTH.codeError);
  return result;
}

function crmEmailToken_(token, secret) {
  const match = typeof token === 'string' && /^([a-f0-9]{64})\.[a-f0-9]{64}$/.exec(token);
  return match && secret ? { key: match[1], digest: crmEmailTokenHash_(token, secret) } : null;
}

function crmEmailIdentity_(token, minimumRole = 'viewer') {
  const props = crmEmailProps_(), parsed = crmEmailToken_(token, crmEmailSecret_(props));
  if (!parsed) throw new Error(CRM_EMAIL_AUTH.sessionError);
  const record = crmEmailRecord_(props, parsed.key);
  const now = Date.now();
  if (!record.sessions.some(session => session.expires > now && crmEmailEqual_(session.digest, parsed.digest))) {
    throw new Error(CRM_EMAIL_AUTH.sessionError);
  }
  const access = crmEmailAccess_(record.email);
  if (!access) throw new Error(CRM_EMAIL_AUTH.sessionError);
  const roles = CRM_EMAIL_AUTH.roles;
  if (!Object.prototype.hasOwnProperty.call(roles, minimumRole) || roles[access.role] < roles[minimumRole]) {
    throw new Error('CRM_FORBIDDEN: У вас нет права на это действие.');
  }
  return access;
}

function crmEmailLogout(token) {
  const parsed = crmEmailToken_(token, crmEmailSecret_(crmEmailProps_()));
  if (!parsed) return true;
  return crmEmailLock_(props => {
    const record = crmEmailRecord_(props, parsed.key);
    const count = record.sessions.length;
    crmEmailPrune_(record, Date.now());
    record.sessions = record.sessions.filter(session => !crmEmailEqual_(session.digest, parsed.digest));
    if (record.sessions.length !== count) crmEmailSave_(props, parsed.key, record);
    return true;
  });
}
