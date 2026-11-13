#!/usr/bin/env python3
"""Local browser fixture for cabinet.js. No Google requests or email delivery.

Run: python3 tests/frontend-fixture.py
Open http://127.0.0.1:8770/cabinet.html and /qa.
Use any valid email and the synthetic code 00000000. This is a test-only server.
"""
import copy
import hashlib
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
STAGES = ['Не обработан', 'Контакт установлен', 'Потребность выявлена', 'КП отправлено', 'Переговоры', 'Клиент', 'Отложено', 'Отказ']
PRIORITIES = ['Не задан', 'Высокий', 'Средний', 'Низкий']
FIELDS = ['stage', 'manager', 'priority', 'next', 'due', 'amount', 'closeDate', 'purchaseDate', 'purchaseAmount', 'reason', 'note', 'contact', 'position']
LOCK = threading.RLock()
STATE = {}


def reset():
    with LOCK:
        STATE.clear()
        STATE.update(cards={}, operations={}, requests=[], fault=None, readDelay=0, sessions=True)
        for suffix in ['A', 'B']:
            fields = dict.fromkeys(FIELDS, '')
            fields.update(stage='КП отправлено', priority='Высокий', manager='QA', next='Тест интерфейса')
            card = dict(id='QA-' + suffix, name='Локальный тест ' + suffix, city='Тестовая среда', address='', profile='Оклейка', qualification='Подтверждено', phones='', email='', websites='', socials='', links=[], fields=fields, version='1', contacts=0, lastContact='', check='', history=[], audit=[])
            STATE['cards'][card['id']] = card


def listing():
    return dict(today='2026-11-12', stages=STAGES, priorities=PRIORITIES, actions=['Звонок', 'Email'], outcomes=['Состоялся', 'Нет ответа'], leads=[dict(id=c['id'], name=c['name'], city=c['city'], profile=c['profile'], qualification=c['qualification'], version=c['version'], **c['fields']) for c in STATE['cards'].values()])


def process(method, args):
    if method == 'crmEmailStart':
        STATE['sessions'] = True
        return {'requestId': 'local-fixture-request'}
    if method == 'crmEmailVerify':
        if args[2] != '00000000':
            raise ValueError('Неверный тестовый код.')
        return dict(token='local-synthetic-session', session=dict(email='qa@example.invalid', role='editor'))
    if method == 'crmEmailLogout':
        STATE['sessions'] = False
        return True
    if not STATE['sessions'] or args[0] != 'local-synthetic-session':
        raise ValueError('CRM_AUTH_REQUIRED')
    if method == 'crmSession':
        return dict(email='qa@example.invalid', role='editor')
    if method == 'crmList':
        return listing()
    if method == 'crmRead':
        return copy.deepcopy(STATE['cards'][args[1]])
    if method == 'crmAuditList':
        return [entry for card in STATE['cards'].values() for entry in card['audit']]
    if method not in ['crmSave', 'crmMove', 'crmRecord']:
        raise ValueError('Неизвестный метод fixture.')
    lead_id, operation_id = args[1], args[-1]
    fingerprint = hashlib.sha256(json.dumps([method, args[1:-1]], sort_keys=True).encode()).hexdigest()
    if operation_id in STATE['operations']:
        previous = STATE['operations'][operation_id]
        if previous['fingerprint'] != fingerprint:
            raise ValueError('Operation payload changed')
        return previous['result']
    card = STATE['cards'][lead_id]
    changes = []
    if method in ['crmSave', 'crmMove']:
        if args[2] != card['version']:
            raise ValueError('CRM_CONFLICT: Карточку уже изменили. Ваши правки оставлены в форме. Загрузите актуальную версию перед новым сохранением.')
        patch = args[3] if method == 'crmSave' else dict(stage=args[3])
        for field, value in patch.items():
            changes.append(dict(field=field, before=card['fields'][field], after=value))
            card['fields'][field] = value
        card['version'] = str(int(card['version']) + 1)
    else:
        event = args[2]
        card['history'].append(dict(at='2026-11-12 02:00 МСК', actor='qa@example.invalid', **event))
        card['contacts'] += 1
        changes.append(dict(field='Касание', before='', after=event['note']))
    card['audit'].append(dict(at='2026-11-12 02:00 МСК', actor='qa@example.invalid', action=method, name=card['name'], changes=changes))
    result = dict(saved=True, operationId=operation_id)
    STATE['operations'][operation_id] = dict(fingerprint=fingerprint, result=result)
    return result


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, content_type='application/json; charset=utf-8'):
        data = body.encode() if isinstance(body, str) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/qa':
            with LOCK:
                status = copy.deepcopy(STATE)
            actions = [('reset', 'Сбросить тест'), ('beforeSave', 'Обрыв до сохранения'), ('afterSave', 'Обрыв после сохранения'), ('afterRecord', 'Обрыв после касания'), ('afterMove', 'Обрыв после переноса'), ('slowRead', 'Задержать следующее чтение'), ('externalA', 'Изменить A извне'), ('externalB', 'Изменить B извне')]
            import html
            controls = ''.join('<button name="action" value="' + action + '">' + label + '</button> ' for action, label in actions)
            page = '<!doctype html><html lang="ru"><meta charset="utf-8"><title>Локальная проверка CRM</title><h1>Тестовая среда — без Google и писем</h1><form method="post" action="/control">' + controls + '</form><p><a href="/qa">Обновить состояние</a> · <a href="/cabinet.html">Кабинет</a></p><pre>' + html.escape(json.dumps(status, ensure_ascii=False, indent=2)) + '</pre></html>'
            self.reply(page, 'text/html; charset=utf-8')
            return
        if path == '/crm-config.js':
            self.reply('window.FIVEROX_CRM_CONFIG = ' + json.dumps(dict(backendUrl='http://127.0.0.1:8770/rpc', release='LOCAL FIXTURE — NO GOOGLE DATA')) + ';', 'text/javascript')
            return
        target = (ROOT / path.lstrip('/')).resolve()
        if not target.is_relative_to(ROOT) or not target.is_file():
            self.send_error(404)
            return
        types = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml'}
        data = target.read_bytes()
        if target.name == 'cabinet.html':
            data = data.replace(b'<title>', b'<title>LOCAL TEST - ')
        self.send_response(200)
        self.send_header('Content-Type', types.get(target.suffix, 'application/octet-stream'))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        if path == '/control':
            action = parse_qs(body.decode()).get('action', [''])[0]
            with LOCK:
                if action == 'reset':
                    reset()
                elif action == 'slowRead':
                    STATE['readDelay'] = 3
                elif action in ['externalA', 'externalB']:
                    card = STATE['cards']['QA-' + action[-1]]
                    card['fields'].update(stage='Переговоры', priority='Средний', note='Правка из тестового сервера')
                    card['version'] = str(int(card['version']) + 1)
                else:
                    options = {'beforeSave': ['crmSave', 'before'], 'afterSave': ['crmSave', 'after'], 'afterRecord': ['crmRecord', 'after'], 'afterMove': ['crmMove', 'after']}
                    STATE['fault'] = options.get(action)
            self.send_response(303)
            self.send_header('Location', '/qa')
            self.end_headers()
            return
        if path != '/rpc':
            self.send_error(404)
            return
        request = json.loads(body)
        method, args = request['method'], request['args']
        with LOCK:
            delay = STATE['readDelay'] if method == 'crmRead' else 0
            if delay:
                STATE['readDelay'] = 0
        if delay:
            time.sleep(delay)
        with LOCK:
            fault = STATE['fault'] if STATE['fault'] and STATE['fault'][0] == method else None
            if fault:
                STATE['fault'] = None
            STATE['requests'].append(dict(method=method, leadId=args[1] if method not in ['crmEmailStart', 'crmEmailVerify', 'crmList', 'crmSession', 'crmEmailLogout'] else None, operationId=args[-1] if method in ['crmSave', 'crmMove', 'crmRecord'] else None, fault=fault))
            if fault and fault[1] == 'before':
                self.close_connection = True
                return
            try:
                result = dict(ok=True, result=process(method, args))
            except (ValueError, KeyError) as error:
                result = dict(ok=False, error=str(error))
            if fault and fault[1] == 'after':
                self.close_connection = True
                return
        self.reply(result)


if __name__ == '__main__':
    reset()
    print('Local fixture: http://127.0.0.1:8770/cabinet.html (synthetic data only)', flush=True)
    ThreadingHTTPServer(('127.0.0.1', 8770), Handler).serve_forever()
