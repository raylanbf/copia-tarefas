// Teste do painel do Copiar Tarefas com chrome.* e a API do Canvas simulados.
// Uso (na pasta tests): npm install && npm test
// As capturas de tela vão para a pasta temporária do sistema (ou para o 1º argumento).
const { chromium } = require('playwright-core');
const path = require('path');

const EXT = path.resolve(__dirname, '..');
const OUT = process.argv[2] || require('os').tmpdir();

// Roda dentro da página, antes do panel.js.
function mock() {
  const log = [];          // toda escrita (não-GET) que chega ao "Canvas"
  window.__log = log;
  window.__opened = [];
  window.__failAfterCreate = {};   // courseId → true: a injeção "cai" depois do POST da tarefa
  let nextId = 70000;

  const db = {
    111: {
      name: 'Cálculo I — Origem', weighted: false,
      groups: [{ id: 11, name: 'Atividades', group_weight: 0 }],
      assignments: [
        { id: 1001, name: 'Atividade 2 — Derivadas', description: '<p>Resolva. <img src="/courses/111/files/9/preview"></p>',
          points_possible: 10, grading_type: 'points', submission_types: ['online_upload', 'online_text_entry'],
          allowed_extensions: ['pdf'], allowed_attempts: 2, due_at: '2026-11-12T02:59:00Z', unlock_at: null, lock_at: null,
          published: true, assignment_group_id: 11, rubric: [{ id: 'c1' }], peer_reviews: false },
        { id: 1002, name: 'Teste 1', submission_types: ['online_quiz'], quiz_id: 5, assignment_group_id: 11, published: true },
        { id: 1003, name: 'Fórum 1', submission_types: ['discussion_topic'], discussion_topic: { id: 7 }, assignment_group_id: 11, published: true },
        { id: 1004, name: 'Tarefa solta', description: '', points_possible: 5, grading_type: 'points', submission_types: ['online_text_entry'],
          assignment_group_id: 11, published: false },
      ],
      modules: [
        { id: 501, name: 'Unidade 2', published: true, items: [
          { id: 9001, type: 'Assignment', content_id: 1001, indent: 1, title: 'Atividade 2 — Derivadas', completion_requirement: { type: 'must_submit', completed: false } },
        ] },
      ],
    },
    222: {
      name: 'Cálculo I — Turma B', weighted: true,
      groups: [{ id: 21, name: 'Provas', group_weight: 60 }, { id: 22, name: 'Atividades', group_weight: 40 }],
      assignments: [{ id: 2001, name: 'Outra tarefa' }],
      modules: [{ id: 601, name: 'Unidade 2', published: false, items: [{ id: 9101, type: 'Page', content_id: 0, title: 'Leitura' }] }],
    },
    333: {
      name: 'Cálculo I — Turma C', weighted: false,
      groups: [{ id: 31, name: 'Tarefas', group_weight: 0 }],
      assignments: [{ id: 3001, name: 'Atividade 2 — Derivadas' }],
      modules: [],
    },
    555: {
      name: 'Cálculo I — Turma D', weighted: false, sisFails: true,
      groups: [{ id: 51, name: 'Atividades', group_weight: 0 }],
      assignments: [],
      modules: [],
    },
  };
  window.__db = db;

  const json = (data, status = 200, headers = {}) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

  // Pagina de 2 em 2, com o Link absoluto como o Canvas faz.
  function paged(list, url) {
    const page = Number(url.searchParams.get('page') || 1);
    const slice = list.slice((page - 1) * 2, page * 2);
    const headers = {};
    if (page * 2 < list.length) {
      const n = new URL(url); n.searchParams.set('page', page + 1);
      headers.Link = `<${n.href}>; rel="next"`;
    }
    return json(slice, 200, headers);
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), 'https://pucminas.instructure.com');
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    const m = url.pathname.match(/^\/api\/v1\/courses\/(\d+)(\/.*)?$/);
    if (!m) return json({ message: 'rota desconhecida' }, 404);
    const c = db[m[1]];
    const rest = m[2] || '';
    if (method !== 'GET') log.push({ method, course: m[1], path: rest, body });
    if (!c) return json({ status: 'unauthorized', errors: [{ message: 'user not authorized to perform that action' }] }, 401);

    if (method === 'GET') {
      if (rest === '') return json({ id: Number(m[1]), name: c.name, apply_assignment_group_weights: c.weighted });
      if (rest === '/assignment_groups') return paged(c.groups, url);
      if (rest === '/assignments') {
        const q = (url.searchParams.get('search_term') || '').toLowerCase();
        return paged(c.assignments.filter(a => !q || a.name.toLowerCase().includes(q)), url);
      }
      if (rest === '/modules') {
        const withItems = url.searchParams.getAll('include[]').includes('items');
        return paged(c.modules.map(mod => withItems ? mod : { ...mod, items: undefined }), url);
      }
      const mi = rest.match(/^\/modules\/(\d+)\/items$/);
      if (mi) return paged(c.modules.find(x => x.id === Number(mi[1])).items, url);
      return json({ message: 'GET desconhecido ' + rest }, 404);
    }

    if (method === 'POST' && rest === '/assignments') {
      const a = { id: nextId++, ...body.assignment };
      a.html_url = `https://pucminas.instructure.com/courses/${m[1]}/assignments/${a.id}`;
      c.assignments.push(a);
      return json(a);
    }
    const pa = rest.match(/^\/assignments\/(\d+)$/);
    if (method === 'PUT' && pa) {
      if (c.sisFails && body.assignment.post_to_sis) {
        return json({ errors: { post_to_sis: [{ attribute: 'post_to_sis', message: 'é preciso ter data de entrega para sincronizar' }] } }, 400);
      }
      Object.assign(c.assignments.find(x => x.id === Number(pa[1])), body.assignment);
      return json({ ok: true });
    }
    if (method === 'POST' && rest === '/modules') {
      const mod = { id: nextId++, name: body.module.name, published: false, items: [] };
      c.modules.push(mod);
      return json(mod);
    }
    const pi = rest.match(/^\/modules\/(\d+)\/items$/);
    if (method === 'POST' && pi) {
      const mod = c.modules.find(x => x.id === Number(pi[1]));
      const it = { id: nextId++, ...body.module_item };
      mod.items.push(it);
      return json(it);
    }
    const pm = rest.match(/^\/modules\/(\d+)$/);
    if (method === 'PUT' && pm) {
      c.modules.find(x => x.id === Number(pm[1])).published = body.module.published;
      return json({ ok: true });
    }
    return json({ message: 'escrita desconhecida' }, 400);
  };

  const store = {};
  window.chrome = {
    runtime: { getManifest: () => ({ version: '1.0' }) },
    storage: { local: {
      get: async k => (k in store ? { [k]: store[k] } : {}),
      set: async o => { Object.assign(store, o); },
    } },
    tabs: {
      query: async () => [{ id: 1, url: window.__tabUrl || 'https://pucminas.instructure.com/courses/111/assignments' }],
      create: async ({ url }) => { window.__opened.push(url); },
    },
    scripting: {
      executeScript: async ({ func, args }) => {
        const result = await func(...args);
        const [op, p] = args;
        if (op === 'create' && window.__failAfterCreate[p.courseId]) {
          delete window.__failAfterCreate[p.courseId];
          throw new Error('Frame with ID 0 was removed.');
        }
        return [{ result }];
      },
    },
  };
}

(async () => {
  const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 380, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.addInitScript(mock);
  await page.goto('file:///' + path.join(EXT, 'panel.html').replace(/\\/g, '/'));

  const results = [];
  const check = (name, cond, extra) => { results.push({ name, ok: !!cond }); if (!cond) console.log('  FALHOU:', name, extra ?? ''); };

  // 1. Origem pela aba atual
  await page.click('#btn-src-tab');
  await page.waitForSelector('.task-item');
  const items = await page.$$eval('.task-item', els => els.map(e => ({ text: e.innerText, blocked: e.classList.contains('blocked') })));
  check('lista 4 itens da origem', items.length === 4, items);
  check('teste e fórum apagados', items.filter(i => i.blocked).length === 2, items);
  check('status da origem', (await page.textContent('#src-status')).includes('2 tarefa(s)'));

  // 2. Escolhe a tarefa
  await page.click('.task-item:not(.blocked) >> text=Atividade 2');
  const detail = await page.textContent('#task-detail');
  check('detalhe mostra módulo', detail.includes('Unidade 2'));
  check('avisa rubrica', detail.includes('rubrica'));
  check('avisa link da origem', detail.includes('1 link(s)'));

  // 3. Destinos e opções
  await page.fill('#dst-input', '222\n333\n444\n111\n555');
  await page.click('label.toggle:has(#opt-publish)');
  await page.click('label.toggle:has(#opt-sis)');
  await page.click('#btn-check');
  await page.waitForSelector('.dst-card');
  await page.waitForFunction(() => !document.querySelector('#btn-check .spinner'));
  const cards = await page.$$eval('.dst-card', els => els.map(e => ({ text: e.innerText, cls: e.className, checked: e.querySelector('.dst-check')?.checked, group: e.querySelector('select')?.selectedOptions[0]?.textContent })));
  check('4 cartões (origem tirada)', cards.length === 4, cards.map(c => c.text.slice(0, 30)));
  check('origem tirada avisada', (await page.textContent('#check-status')).includes('origem foi tirado'));
  const c222 = cards.find(c => c.text.includes('#222'));
  const c333 = cards.find(c => c.text.includes('#333'));
  const c444 = cards.find(c => c.text.includes('#444'));
  const c555 = cards.find(c => c.text.includes('#555'));
  check('222 grupo de mesmo nome, com peso', c222.group === 'Atividades (40%)', c222.group);
  check('222 reusa módulo e avisa despublicado', c222.text.includes('que já existe') && c222.text.includes('despublicado'), c222.text);
  check('333 duplicata desmarcada', c333.checked === false && c333.text.includes('Já existe'), c333);
  check('444 erro de acesso', c444.cls.includes('error') && c444.text.includes('401'), c444.text);
  check('555 cria módulo', c555.text.includes('Cria o módulo'), c555.text);
  await page.screenshot({ path: path.join(OUT, '1-conferencia.png'), fullPage: true });

  // Marca a 333 mesmo assim (tem que criar outra, sem mexer na existente)
  await page.click('.dst-card:has-text("#333") .dst-check');
  check('botão conta 3 cursos', (await page.textContent('#btn-run')).includes('3 cursos'));

  // 4. Cria — com a injeção caindo depois do POST na 555
  await page.evaluate(() => { window.__failAfterCreate['555'] = true; });
  await page.click('#btn-run');
  await page.waitForSelector('#modal-confirm:not([hidden])');
  const confirmText = await page.textContent('#confirm-detail');
  check('confirmação lista os 3 cursos', ['#222', '#333', '#555'].every(id => confirmText.includes(id)) && !confirmText.includes('#444'));
  await page.screenshot({ path: path.join(OUT, '2-confirmacao.png') });
  await page.click('#btn-confirm-ok');
  await page.waitForSelector('#run-summary:not([hidden])', { timeout: 20000 });
  await page.screenshot({ path: path.join(OUT, '3-resultado.png'), fullPage: true });

  let log = await page.evaluate(() => window.__log);
  const db = await page.evaluate(() => window.__db);
  check('nenhuma escrita na origem', !log.some(w => w.course === '111'), log);
  check('nenhuma escrita no 444', !log.some(w => w.course === '444'));
  const creates = log.filter(w => w.method === 'POST' && w.path === '/assignments');
  check('1 tarefa criada por curso (sem duplicar na 555)', ['222', '333', '555'].every(id => creates.filter(w => w.course === id).length === 1), creates.map(w => w.course));
  check('555 tem só 1 tarefa nova', db[555].assignments.length === 1);
  check('333 manteve a existente e ganhou outra', db[333].assignments.length === 2 && db[333].assignments[0].id === 3001);
  const p222 = creates.find(w => w.course === '222').body.assignment;
  check('222 no grupo 22', p222.assignment_group_id === 22);
  check('payload publicado, SIS falso na criação, data mantida', p222.published === true && p222.post_to_sis === false && p222.due_at === '2026-11-12T02:59:00Z');
  check('payload copia descrição e envio', p222.description.includes('Resolva') && p222.submission_types.length === 2 && p222.allowed_extensions[0] === 'pdf' && p222.allowed_attempts === 2);
  check('222 módulo existente intocado (sem PUT)', !log.some(w => w.course === '222' && w.path === '/modules/601'));
  check('222 item no fim, sem requisito', (() => { const it = db[222].modules[0].items; return it.length === 2 && it[0].id === 9101 && !it[1].completion_requirement && it[1].indent === 1; })());
  check('222 módulo existente continua despublicado', db[222].modules[0].published === false);
  check('333 módulo novo com requisito e publicado', (() => { const mod = db[333].modules[0]; return mod && mod.published === true && mod.items.length === 1 && mod.items[0].completion_requirement?.type === 'must_submit'; })(), db[333].modules);
  check('nenhum grupo de tarefas criado/alterado', !log.some(w => w.path.includes('assignment_groups')));
  const writePaths = [...new Set(log.map(w => `${w.method} ${w.path.replace(/\d+/g, ':id')}`))].sort();
  check('só escritas permitidas', writePaths.every(p => ['POST /assignments', 'PUT /assignments/:id', 'POST /modules', 'POST /modules/:id/items', 'PUT /modules/:id'].includes(p)), writePaths);
  const summary = await page.textContent('#run-summary');
  check('resumo: 2 ok + 1 aviso (SIS)', summary.includes('2 curso(s) concluído(s)') && summary.includes('1 com a tarefa criada'), summary);
  const card555 = await page.textContent('.dst-card:has-text("#555")');
  check('555 mostra o motivo do SIS', card555.includes('data de entrega'), card555);
  check('botão de tentar de novo', (await page.textContent('#btn-run')).includes('Tentar de novo'));

  // 5. Tentar de novo depois de resolver o SIS: só o passo do SIS
  await page.evaluate(() => { window.__db[555].sisFails = false; window.__log.length = 0; });
  await page.click('#btn-run');
  await page.waitForFunction(() => document.querySelector('#run-summary') && !document.querySelector('#run-summary').hidden && document.querySelector('#run-summary').innerText.includes('3 curso(s)'), null, { timeout: 20000 });
  log = await page.evaluate(() => window.__log);
  check('retry só liga o SIS na 555', log.length === 1 && log[0].course === '555' && log[0].method === 'PUT' && log[0].body.assignment.post_to_sis === true, log);
  check('botão some quando tudo terminou', await page.$eval('#btn-run', b => b.hidden));

  // 6. Abrir a tarefa criada
  await page.click('.dst-card:has-text("#222") a[data-url]');
  const opened = await page.evaluate(() => window.__opened);
  check('link abre a tarefa criada', opened[0]?.includes('/courses/222/assignments/'));
  await page.screenshot({ path: path.join(OUT, '4-final.png'), fullPage: true });

  check('sem erros no console', !errors.length, errors);
  await browser.close();

  const failed = results.filter(r => !r.ok);
  console.log(`${results.length - failed.length}/${results.length} verificações passaram`);
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
