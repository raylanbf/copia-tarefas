'use strict';

// Copiar Tarefas — lê uma tarefa num curso do Canvas (a origem) e cria uma
// cópia dela em até 10 outros cursos (os destinos).
//
// Regra: a origem só é LIDA, e nos destinos a extensão só CRIA — a tarefa e,
// com a opção ligada, o módulo dela. Nada que já existe é alterado: os cursos
// têm conteúdo e alunos ativos. Por isso a tarefa é criada campo a campo pela
// API, e não pela "Importação de conteúdo" do Canvas — a importação procura o
// grupo de tarefas pelo nome e sobrescreve o peso e as regras dele, e atualiza
// uma tarefa já copiada antes em vez de criar outra.
//
// As chamadas à API rodam na aba do Canvas, com a sessão de quem está logado
// (sem token): o painel injeta canvasMain, uma operação por vez.

// ── Constantes ────────────────────────────────────────────────────────
const MAX_COURSES = 10;

const OPT_DEFAULTS = { module: true, moduleExisting: 'reuse', publish: false, sis: false, dates: 'keep' };

// Tipos de envio que a cópia campo a campo reproduz por inteiro. Testes,
// fóruns, ferramentas externas (LTI, Novos Testes) e anotação dependem de
// outros objetos do curso e ficam de fora.
const SUBMISSION_LABELS = {
  online_text_entry: 'Texto',
  online_url:        'Site',
  online_upload:     'Arquivo',
  media_recording:   'Mídia',
  on_paper:          'Em papel',
  none:              'Sem envio',
  not_graded:        'Não avaliada',
};

const CANVAS_URL = /^https:\/\/([\w-]+\.instructure\.com|canvas\.pucminas\.br)\//;

const RED = '#f87171', ORANGE = '#f97316', GREEN = '#4ade80';

// ── Estado ────────────────────────────────────────────────────────────
let opts    = { ...OPT_DEFAULTS };
let _src    = null;    // { id, name, tasks } — curso de origem listado
let _task   = null;    // tarefa escolhida na origem
let _dests  = null;    // conferência: [{ courseId, name, error, groups, groupId, dupeIds, module, moduleIds, checked }]
let _run    = {};      // courseId → progresso da criação naquele curso
let _plan   = null;    // opções congeladas no início da criação (o "tentar de novo" usa as mesmas)
let _phase  = 'idle';  // 'idle' | 'checking' | 'running' | 'done'
let _srcGen = 0;       // muda quando a origem muda: listagem antiga que volta depois é descartada
let _dstGen = 0;       // idem, para a conferência

// ── Helpers ───────────────────────────────────────────────────────────
const $     = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm  = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

function esc(str) {
  return String(str ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function parseCourseIds(text) {
  return [...new Set(text.split(/[\n,;\s]+/).map(s => s.trim()).filter(s => /^\d+$/.test(s)))];
}

function fmtDate(iso) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}

function fmtPoints(t) {
  return t.grading_type === 'not_graded' ? 'sem nota' : `${t.points_possible ?? 0} pts`;
}

function setStatus(id, msg, color) {
  const el = $(id);
  el.textContent = msg || '';
  el.style.color = color || '#94a3b8';
  el.hidden = !msg;
}

function busyBtn(btn, text) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled  = true;
  btn.innerHTML = `<span class="spinner"></span>${esc(text)}`;
}

function freeBtn(btn) {
  btn.disabled    = false;
  btn.textContent = btn.dataset.label;
}

const kv = (k, v) => `<div class="kv"><span class="kv-label">${esc(k)}</span><span class="kv-value">${esc(v)}</span></div>`;

// ── Aba do Canvas ─────────────────────────────────────────────────────
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function canvasTab() {
  const tab = await activeTab();
  if (!tab?.id || !CANVAS_URL.test(tab.url || '')) {
    throw new Error('Abra uma aba do Canvas (qualquer página) para usar a extensão.');
  }
  return tab;
}

async function tabCourseId() {
  const tab = await activeTab();
  return CANVAS_URL.test(tab?.url || '') ? (tab.url.match(/\/courses\/(\d+)/)?.[1] || null) : null;
}

class CanvasError extends Error {}

// Roda uma operação de canvasMain na aba. Se a aba estiver recarregando (a
// injeção falha ou volta sem resultado), espera e tenta de novo — repetir é
// seguro porque toda operação de escrita confere antes se já foi feita.
async function exec(tabId, op, p) {
  for (let attempt = 0; ; attempt++) {
    let out;
    try {
      const [res] = await chrome.scripting.executeScript({ target: { tabId }, func: canvasMain, args: [op, p] });
      out = res?.result;
    } catch (err) {
      if (attempt >= 2) throw new Error('não consegui falar com a aba do Canvas — ' + err.message);
      await sleep(1500);
      continue;
    }
    if (out == null) {
      if (attempt >= 2) throw new Error('a aba do Canvas não respondeu — ela foi fechada ou saiu do Canvas?');
      await sleep(1500);
      continue;
    }
    if (out.__error) throw new CanvasError(out.__error);
    return out;
  }
}

// Roda NA ABA do Canvas (serializada pelo executeScript): não enxerga nada
// deste arquivo, tudo entra por `p`. As leituras usam GET; as escritas passam
// por write(), que só aceita o curso de destino — nunca o de origem.
function canvasMain(op, p) {
  return (async () => {
    try {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const norm  = s => (s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

      const rawCsrf = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith('_csrf_token='));
      const csrf = rawCsrf
        ? decodeURIComponent(rawCsrf.split('=').slice(1).join('='))
        : decodeURIComponent(document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '');

      // Mensagem legível a partir da resposta de erro do Canvas.
      function errorText(status, text) {
        let msg = '';
        try {
          const data = JSON.parse(text.replace(/^while\(1\);/, ''));
          const errs = data.errors;
          const list = Array.isArray(errs) ? errs
            : errs && typeof errs === 'object'
              ? Object.entries(errs).flatMap(([field, v]) => [].concat(v).map(e => `${field}: ${e?.message || e}`))
              : [];
          msg = list.map(e => (typeof e === 'string' ? e : e?.message || JSON.stringify(e))).join('; ')
             || data.message || '';
        } catch { /* resposta não é JSON */ }
        if (!msg && status === 401) msg = 'sem permissão (a sessão do Canvas pode ter expirado)';
        if (!msg && status === 404) msg = 'não encontrado';
        return `HTTP ${status}${msg ? ' — ' + msg.slice(0, 200) : ''}`;
      }

      async function request(method, url, body) {
        for (let attempt = 0; ; attempt++) {
          const res = await fetch(url, {
            method,
            headers: body
              ? { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
              : { Accept: 'application/json' },
            body: body ? JSON.stringify(body) : undefined,
          });
          const text = await res.text();
          // Limite de requisições: o Canvas recusou sem processar, então
          // repetir não duplica nada.
          const limited = res.status === 429 || (res.status === 403 && /rate limit/i.test(text));
          if (limited && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
          if (!res.ok) throw new Error(errorText(res.status, text));
          if (parseFloat(res.headers.get('X-Rate-Limit-Remaining') || '999') < 30) await sleep(800);
          return {
            data: text ? JSON.parse(text.replace(/^while\(1\);/, '')) : null,
            next: (res.headers.get('Link') || '').match(/<([^>]+)>;\s*rel="next"/)?.[1] || null,
          };
        }
      }

      const get = async url => (await request('GET', url)).data;

      async function getAll(url) {
        const out = [];
        for (let next = url, guard = 0; next && guard < 50; guard++) {
          const page = await request('GET', next);
          if (Array.isArray(page.data)) out.push(...page.data);
          next = page.next;
        }
        return out;
      }

      const api = `/api/v1/courses/${p.courseId}`;

      // Única porta de escrita: só no curso de destino desta operação, e
      // nunca se ele for o de origem.
      async function write(method, path, body) {
        if (!p.sourceId || String(p.courseId) === String(p.sourceId)) {
          throw new Error('bloqueado: a extensão não altera o curso de origem');
        }
        return (await request(method, api + path, body)).data;
      }

      // Busca por nome (o Canvas exige 3+ letras no search_term).
      const searchParam = name => (name.length >= 3 ? `&search_term=${encodeURIComponent(name)}` : '');

      // ── Leitura da origem: tarefas, com grupo e módulo de cada uma ──
      if (op === 'source') {
        const [course, assignments, groups, modules] = await Promise.all([
          get(api),
          getAll(`${api}/assignments?per_page=100&order_by=position`),
          getAll(`${api}/assignment_groups?per_page=100`),
          getAll(`${api}/modules?per_page=100&include[]=items`),
        ]);
        // Módulo com muitos itens pode vir sem eles embutidos: busca à parte.
        for (const m of modules) {
          if (!Array.isArray(m.items)) m.items = await getAll(`${api}/modules/${m.id}/items?per_page=100`);
        }

        const groupName = Object.fromEntries(groups.map(g => [g.id, g.name]));
        const moduleOf  = {};
        for (const m of modules) {
          for (const it of m.items) {
            if (it.type !== 'Assignment' || moduleOf[it.content_id]) continue;
            const req = it.completion_requirement;
            moduleOf[it.content_id] = {
              name:   m.name,
              indent: it.indent || 0,
              requirement: req ? { type: req.type, ...(req.min_score != null ? { min_score: req.min_score } : {}) } : null,
            };
          }
        }

        return {
          name: course.name,
          tasks: assignments.map(a => ({
            id:                     a.id,
            name:                   a.name,
            description:            a.description || '',
            points_possible:        a.points_possible,
            grading_type:           a.grading_type,
            submission_types:       a.submission_types || [],
            allowed_extensions:     a.allowed_extensions || [],
            allowed_attempts:       a.allowed_attempts,
            omit_from_final_grade:  !!a.omit_from_final_grade,
            peer_reviews:           !!a.peer_reviews,
            automatic_peer_reviews: !!a.automatic_peer_reviews,
            peer_review_count:      a.peer_review_count || 0,
            due_at:                 a.due_at,
            unlock_at:              a.unlock_at,
            lock_at:                a.lock_at,
            published:              a.published !== false,
            isQuiz:                 !!(a.quiz_id || a.is_quiz_assignment),
            isDiscussion:           !!a.discussion_topic,
            groupCategory:          !!a.group_category_id,
            hasRubric:              Array.isArray(a.rubric) && a.rubric.length > 0,
            hasOverrides:           !!(a.has_overrides || a.only_visible_to_overrides),
            moderated:              !!(a.moderated_grading || a.anonymous_grading),
            group:                  groupName[a.assignment_group_id] || '',
            module:                 moduleOf[a.id] || null,
          })),
        };
      }

      // ── Conferência de um destino (só leitura) ────────────────────
      if (op === 'dest') {
        const [course, groups, modules, same] = await Promise.all([
          get(api),
          getAll(`${api}/assignment_groups?per_page=100`),
          getAll(`${api}/modules?per_page=100`),
          getAll(`${api}/assignments?per_page=100${searchParam(p.taskName)}`),
        ]);
        const sameModules = p.moduleName ? modules.filter(m => norm(m.name) === norm(p.moduleName)) : [];
        const mod = sameModules[0];
        return {
          name:      course.name,
          weighted:  !!course.apply_assignment_group_weights,
          groups:    groups.map(g => ({ id: g.id, name: g.name, weight: g.group_weight || 0 })),
          dupeIds:   same.filter(a => norm(a.name) === norm(p.taskName)).map(a => a.id),
          module:    mod ? { id: mod.id, name: mod.name, published: mod.published !== false } : null,
          moduleIds: sameModules.map(m => m.id),
        };
      }

      // ── Escritas (só criam) ───────────────────────────────────────
      // Cada uma confere antes se uma tentativa anterior já fez o trabalho
      // (a aba pode recarregar antes da resposta chegar): assim, repetir
      // nunca cria duas vezes.

      if (op === 'create') {
        const name = p.payload.assignment.name;
        const same = await getAll(`${api}/assignments?per_page=100${searchParam(name)}`);
        const made = same.find(a => norm(a.name) === norm(name) && !p.knownIds.includes(a.id));
        if (made) return { id: made.id, url: made.html_url, adopted: true };
        const a = await write('POST', '/assignments', p.payload);
        return { id: a.id, url: a.html_url };
      }

      // Só na tarefa criada nesta cópia.
      if (op === 'sis') {
        await write('PUT', `/assignments/${p.assignmentId}`, { assignment: { post_to_sis: true } });
        return { ok: true };
      }

      // Entra no fim da lista de módulos (sem `position`): os existentes não
      // mudam de lugar. O Canvas cria o módulo despublicado.
      if (op === 'createModule') {
        const mods = await getAll(`${api}/modules?per_page=100`);
        const made = mods.find(m => norm(m.name) === norm(p.name) && !p.knownIds.includes(m.id));
        if (made) return { id: made.id, adopted: true };
        const m = await write('POST', '/modules', { module: { name: p.name } });
        return { id: m.id };
      }

      // Entra no fim do módulo (sem `position`): os itens existentes não
      // mudam de lugar.
      if (op === 'addItem') {
        const items = await getAll(`${api}/modules/${p.moduleId}/items?per_page=100`);
        if (items.some(it => it.type === 'Assignment' && it.content_id === p.assignmentId)) return { ok: true, adopted: true };
        const item = { type: 'Assignment', content_id: p.assignmentId, indent: p.indent || 0 };
        if (p.requirement) item.completion_requirement = p.requirement;
        await write('POST', `/modules/${p.moduleId}/items`, { module_item: item });
        return { ok: true };
      }

      // Publicar um módulo pela API publica também todos os itens dele. Por
      // isso só publica se o módulo tiver apenas a tarefa criada agora.
      if (op === 'publishModule') {
        const items = await getAll(`${api}/modules/${p.moduleId}/items?per_page=100`);
        if (items.some(it => !(it.type === 'Assignment' && it.content_id === p.assignmentId))) {
          throw new Error('o módulo tem outros itens — não foi publicado, para não publicar nada além da tarefa');
        }
        await write('PUT', `/modules/${p.moduleId}`, { module: { published: true } });
        return { ok: true };
      }

      return { __error: `operação desconhecida: ${op}` };
    } catch (err) {
      return { __error: err.message };
    }
  })();
}

// ── Origem ────────────────────────────────────────────────────────────
function blockReason(t) {
  const types = t.submission_types || [];
  if (t.isQuiz || types.includes('online_quiz')) return 'teste';
  if (t.isDiscussion || types.includes('discussion_topic')) return 'fórum';
  if (types.includes('external_tool')) return 'ferramenta externa (LTI ou Novos Testes)';
  if (t.groupCategory) return 'trabalho em grupo';
  const other = types.filter(s => !(s in SUBMISSION_LABELS));
  if (other.length) return `tipo de envio "${other.join(', ')}"`;
  return null;
}

// O que da tarefa NÃO vai junto na cópia.
function taskWarnings(t, sourceId) {
  const w = [];
  if (t.hasRubric)    w.push('Tem rubrica — ela não é copiada; se precisar, crie no destino.');
  if (t.hasOverrides) w.push('Tem datas por turma ou por aluno — só as datas gerais são copiadas.');
  if (t.moderated)    w.push('Usa avaliação moderada ou anônima — isso não é copiado.');
  const links = (t.description.match(new RegExp(`/courses/${sourceId}/`, 'g')) || []).length;
  if (links) {
    w.push(`A descrição tem ${links} link(s) ou imagem(ns) do curso de origem — os alunos dos destinos podem não conseguir abrir.`);
  }
  return w;
}

function clearSource() {
  _src  = null;
  _task = null;
  $('src-section').hidden = true;
  clearDests();
}

async function doListSource() {
  const id = $('src-input').value.trim();
  if (!/^\d+$/.test(id)) { setStatus('src-status', '✗ Informe o ID do curso (só números).', RED); return; }

  const gen = ++_srcGen;
  clearSource();
  setStatus('src-status', '');
  busyBtn($('btn-src-list'), 'Lendo o curso...');
  try {
    const tab  = await canvasTab();
    const data = await exec(tab.id, 'source', { courseId: id });
    if (gen !== _srcGen) return;
    _src = { id, name: data.name, tasks: data.tasks.map(t => ({ ...t, blocked: blockReason(t) })) };
    const ok    = _src.tasks.filter(t => !t.blocked).length;
    const other = _src.tasks.length - ok;
    if (!_src.tasks.length) setStatus('src-status', 'Nenhuma tarefa neste curso.', ORANGE);
    else setStatus('src-status', `${ok} tarefa(s) podem ser copiadas${other ? ` · ${other} de outro tipo (testes, fóruns…) aparecem apagadas` : ''}.`, ok ? GREEN : ORANGE);
    renderSource();
  } catch (err) {
    if (gen === _srcGen) setStatus('src-status', '✗ ' + err.message, RED);
  } finally {
    freeBtn($('btn-src-list'));
  }
}

function renderSource() {
  $('src-section').hidden = !_src;
  if (!_src) return;
  $('src-course').textContent = `#${_src.id} · ${_src.name}`;
  $('task-filter').value = '';
  renderTaskList();
  renderTaskDetail();
}

function renderTaskList() {
  const list = $('task-list');
  list.innerHTML = '';
  const term  = norm($('task-filter').value);
  const shown = _src.tasks.filter(t => !term || norm(t.name).includes(term));
  if (!shown.length) {
    list.innerHTML = `<div class="task-empty">${_src.tasks.length ? 'Nenhuma tarefa com esse nome.' : 'Nenhuma tarefa neste curso.'}</div>`;
    return;
  }
  for (const t of shown) {
    const row = document.createElement('div');
    row.className = 'task-item' + (t.blocked ? ' blocked' : '') + (_task?.id === t.id ? ' selected' : '');
    const meta = t.blocked
      ? `não copiável nesta versão: ${t.blocked}`
      : `${t.module ? '📚 ' + t.module.name : 'fora de módulo'} · ${fmtPoints(t)}`;
    row.innerHTML =
      `<div class="task-title">${esc(t.name)}${t.published ? '' : '<span class="task-tag">não publicada</span>'}</div>` +
      `<div class="task-meta">${esc(meta)}</div>`;
    if (t.blocked) row.title = 'Esta versão copia só tarefas comuns (envio de texto, arquivo, site, mídia ou sem envio).';
    else row.addEventListener('click', () => selectTask(t));
    list.appendChild(row);
  }
}

function selectTask(t) {
  if (_phase === 'running' || _phase === 'checking' || _task?.id === t.id) return;
  _task = t;
  _dstGen++;
  clearDests();
  renderTaskList();
  renderTaskDetail();
}

function renderTaskDetail() {
  const box = $('task-detail');
  box.hidden = !_task;
  if (!_task) return;
  const t = _task;
  const envio = t.submission_types.map(s => SUBMISSION_LABELS[s] || s).join(', ') || '—';
  const datas = [
    t.unlock_at && `de ${fmtDate(t.unlock_at)}`,
    t.due_at    && `entrega ${fmtDate(t.due_at)}`,
    t.lock_at   && `até ${fmtDate(t.lock_at)}`,
  ].filter(Boolean).join(' · ') || 'sem datas';
  box.innerHTML =
    kv('Tarefa', t.name) +
    kv('Grupo', t.group || '—') +
    kv('Nota', fmtPoints(t)) +
    kv('Envio', envio) +
    kv('Datas', datas) +
    kv('Módulo', t.module ? t.module.name : 'nenhum (fica só na lista de Tarefas)') +
    taskWarnings(t, _src.id).map(w => `<div class="note warn">⚠ ${esc(w)}</div>`).join('');
}

// ── Destinos: conferência ─────────────────────────────────────────────
function clearDests() {
  _dests = null;
  _run   = {};
  _plan  = null;
  if (_phase === 'done') _phase = 'idle';
  $('dst-results').innerHTML = '';
  $('run-summary').hidden = true;
  setStatus('check-status', '');
  syncUI();
}

// Grupo de tarefas do destino: o de mesmo nome que o da origem; senão, o
// primeiro. Nunca cria nem altera grupo — quem escolhe é o seletor do cartão.
function pickGroup(groups) {
  const same = groups.find(g => norm(g.name) === norm(_task.group));
  return (same || groups[0])?.id ?? null;
}

async function doCheck() {
  if (!_task) { setStatus('check-status', '✗ Liste as tarefas da origem e escolha uma.', RED); return; }
  let ids = parseCourseIds($('dst-input').value);
  const hadSource = ids.includes(_src.id);
  ids = ids.filter(id => id !== _src.id);
  if (!ids.length) {
    setStatus('check-status', hadSource ? '✗ O curso de origem não pode ser destino.' : '✗ Informe ao menos um curso de destino.', RED);
    return;
  }
  if (ids.length > MAX_COURSES) {
    setStatus('check-status', `✗ Máximo de ${MAX_COURSES} cursos — você informou ${ids.length}.`, RED);
    return;
  }

  const gen = ++_dstGen;
  clearDests();
  _phase = 'checking';
  syncUI();
  const btn = $('btn-check');
  try {
    const tab = await canvasTab();
    const p   = { taskName: _task.name, moduleName: _task.module?.name || '' };
    const dests = [];
    // Um curso por vez: são poucas leituras em cada, e assim não pesa no
    // limite de requisições do Canvas.
    for (const courseId of ids) {
      busyBtn(btn, `Conferindo ${dests.length + 1} de ${ids.length}...`);
      try {
        const d = await exec(tab.id, 'dest', { ...p, courseId });
        dests.push({ courseId, ...d, groupId: pickGroup(d.groups), checked: !d.dupeIds.length });
      } catch (err) {
        dests.push({ courseId, error: err.message, checked: false });
      }
      if (gen !== _dstGen) return;
    }
    _dests = dests;
    const ok    = dests.filter(d => !d.error).length;
    const dupes = dests.filter(d => d.dupeIds?.length).length;
    let msg = `${ok} de ${dests.length} curso(s) conferido(s).`;
    if (dupes) msg += ` ${dupes} já têm tarefa com esse nome e ficaram desmarcados.`;
    if (hadSource) msg += ' O curso de origem foi tirado dos destinos.';
    setStatus('check-status', ok ? msg + ' Revise os grupos antes de criar.' : msg, ok ? GREEN : RED);
  } catch (err) {
    if (gen === _dstGen) setStatus('check-status', '✗ ' + err.message, RED);
  } finally {
    freeBtn(btn);
    if (_phase === 'checking') _phase = 'idle';
    syncUI();
    renderDests();
  }
}

// Onde a tarefa entra, em texto, para o cartão e a confirmação.
function moduleNote(d, o) {
  if (!o.module)      return { text: 'Sem módulo: a tarefa fica só na lista de Tarefas.' };
  if (!_task.module)  return { text: 'Na origem a tarefa não está em módulo — fica só na lista de Tarefas.' };
  const name = _task.module.name;
  if (d.module && o.moduleExisting === 'reuse') {
    return {
      text: `Entra no fim do módulo "${name}", que já existe — sem requisito de conclusão, para não mudar o progresso de quem já concluiu o módulo.`,
      warn: d.module.published ? null : 'Esse módulo está despublicado neste curso: os alunos não verão a tarefa por ele.',
    };
  }
  const req   = _task.module.requirement ? ', com o mesmo requisito de conclusão da origem' : '';
  const which = d.module ? 'outro' : 'o';
  const why   = d.module ? ' (já existe um com esse nome)' : '';
  return { text: `Cria ${which} módulo "${name}" no fim do curso${why}, só com a tarefa${req} — ${o.publish ? 'publicado' : 'despublicado'}.` };
}

function renderDests() {
  const box = $('dst-results');
  box.innerHTML = '';
  if (_dests) _dests.forEach(d => box.appendChild(destCard(d)));
  syncRunBtn();
}

function destCard(d) {
  const run    = _run[d.courseId];
  const locked = _phase !== 'idle' || !!run;
  const card   = document.createElement('div');
  const state  = d.error ? 'error' : run ? run.status : d.checked ? '' : 'off';
  card.className = 'dst-card ' + ({ ok: 'ok', warn: 'warn', error: 'error', off: 'off' }[state] || '');

  const badge = d.error ? '❌'
    : !run ? ''
    : run.status === 'running' ? '<span class="spinner"></span>'
    : { ok: '✅', warn: '⚠️', error: '❌', pending: '⏳' }[run.status] || '';

  const head = document.createElement(d.error || run ? 'div' : 'label');
  head.className = 'dst-head';
  if (!d.error && !run) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'dst-check';
    cb.checked  = d.checked;
    cb.disabled = locked;
    cb.addEventListener('change', () => { d.checked = cb.checked; renderDests(); });
    head.appendChild(cb);
  }
  head.insertAdjacentHTML('beforeend',
    `<span class="dst-id">#${esc(d.courseId)}</span>` +
    `<span class="dst-name" title="${esc(d.name || '')}">${esc(d.name || '')}</span>` +
    `<span class="dst-badge">${badge}</span>`);
  card.appendChild(head);

  if (d.error) {
    card.insertAdjacentHTML('beforeend', `<div class="note error">✗ ${esc(d.error)}</div>`);
    return card;
  }

  // Grupo de tarefas (só os que já existem no curso).
  const line = document.createElement('div');
  line.className = 'dst-line';
  if (d.groups.length) {
    line.innerHTML = '<span class="kv-label">Grupo</span>';
    const sel = document.createElement('select');
    sel.disabled = locked;
    for (const g of d.groups) {
      const o = document.createElement('option');
      o.value = g.id;
      o.textContent = d.weighted ? `${g.name} (${g.weight}%)` : g.name;
      o.selected = g.id === d.groupId;
      sel.appendChild(o);
    }
    sel.addEventListener('change', () => { d.groupId = Number(sel.value); });
    line.appendChild(sel);
  } else {
    line.innerHTML = '<span class="muted">Sem grupos de tarefas: o Canvas põe a tarefa no grupo padrão.</span>';
  }
  card.appendChild(line);

  const m = moduleNote(d, run ? _plan : opts);
  card.insertAdjacentHTML('beforeend', `<div class="note">📚 ${esc(m.text)}</div>`);
  if (m.warn) card.insertAdjacentHTML('beforeend', `<div class="note warn">⚠ ${esc(m.warn)}</div>`);
  if (d.dupeIds.length && !run) {
    card.insertAdjacentHTML('beforeend',
      `<div class="note warn">⚠ Já existe ${d.dupeIds.length > 1 ? d.dupeIds.length + ' tarefas' : 'uma tarefa'} com esse nome neste curso. ` +
      `${d.checked ? 'Vai ser criada mais uma.' : 'Desmarcado para não duplicar — marque se quiser criar mesmo assim.'}</div>`);
  }

  if (run) card.appendChild(runSteps(run));
  return card;
}

// ── Criação ───────────────────────────────────────────────────────────
function taskPayload(t, plan, groupId) {
  const a = {
    name:                   t.name,
    description:            t.description,
    points_possible:        t.points_possible ?? 0,
    grading_type:           t.grading_type,
    submission_types:       t.submission_types,
    allowed_attempts:       t.allowed_attempts ?? -1,
    omit_from_final_grade:  t.omit_from_final_grade,
    peer_reviews:           t.peer_reviews,
    automatic_peer_reviews: t.automatic_peer_reviews,
    published:              !!plan.publish,
    // O SIS é ligado num passo à parte: se o Canvas recusar (ex.: exige data
    // de entrega), a tarefa já está criada e só esse passo falha.
    post_to_sis:            false,
  };
  if (t.allowed_extensions.length) a.allowed_extensions = t.allowed_extensions;
  if (t.peer_reviews && t.automatic_peer_reviews && t.peer_review_count) a.peer_review_count = t.peer_review_count;
  if (groupId) a.assignment_group_id = groupId;
  if (plan.dates === 'keep') {
    if (t.due_at)    a.due_at    = t.due_at;
    if (t.unlock_at) a.unlock_at = t.unlock_at;
    if (t.lock_at)   a.lock_at   = t.lock_at;
  }
  return { assignment: a };
}

// Passos de um curso, retomáveis: o "tentar de novo" pula o que já foi feito.
async function runCourse(d) {
  const r    = _run[d.courseId];
  const plan = _plan;
  const call = (op, extra) => exec(plan.tabId, op, { courseId: d.courseId, sourceId: plan.sourceId, ...extra });
  const step = name => { r.current = name; r.status = 'running'; renderDests(); };

  if (!r.assignmentId) {
    step('create');
    try {
      const out = await call('create', { payload: taskPayload(plan.task, plan, d.groupId), knownIds: d.dupeIds });
      r.assignmentId  = out.id;
      r.assignmentUrl = out.url;
      r.createError   = null;
    } catch (err) {
      r.createError = err.message;
      r.current     = null;
      r.status      = 'error';
      return;   // sem a tarefa, os outros passos não têm o que fazer
    }
  }

  if (plan.sis && !r.sisDone) {
    step('sis');
    try {
      await call('sis', { assignmentId: r.assignmentId });
      r.sisDone  = true;
      r.sisError = null;
    } catch (err) {
      r.sisError = err.message;
    }
  }

  const m = plan.task.module;
  if (plan.module && m && !r.moduleDone) {
    step('module');
    try {
      if (!r.moduleId) {
        if (d.module && plan.moduleExisting === 'reuse') {
          r.moduleId      = d.module.id;
          r.moduleCreated = false;
        } else {
          const out = await call('createModule', { name: m.name, knownIds: d.moduleIds });
          r.moduleId      = out.id;
          r.moduleCreated = true;
        }
      }
      if (!r.itemDone) {
        await call('addItem', {
          moduleId:     r.moduleId,
          assignmentId: r.assignmentId,
          indent:       m.indent,
          // Requisito só em módulo novo: num módulo existente, um requisito a
          // mais tiraria o "concluído" de quem já tinha concluído o módulo.
          requirement:  r.moduleCreated ? m.requirement : null,
        });
        r.itemDone = true;
      }
      if (r.moduleCreated && plan.publish && !r.modulePublished) {
        await call('publishModule', { moduleId: r.moduleId, assignmentId: r.assignmentId });
        r.modulePublished = true;
      }
      r.moduleDone  = true;
      r.moduleError = null;
    } catch (err) {
      r.moduleError = err.message;
    }
  }

  r.current = null;
  r.status  = r.sisError || r.moduleError ? 'warn' : 'ok';
}

function runSteps(r) {
  const plan  = _plan;
  const box   = document.createElement('div');
  box.className = 'steps';
  const lines = [];
  const add = (state, text, html) => {
    const icon = { wait: '·', busy: '<span class="spinner"></span>', ok: '✓', warn: '⚠', error: '✗' }[state];
    lines.push(`<div class="step ${state}"><span class="step-icon">${icon}</span><span class="step-text">${html ?? esc(text)}</span></div>`);
  };

  if (r.assignmentId) {
    const open = r.assignmentUrl ? ` <a data-url="${esc(r.assignmentUrl)}">abrir</a>` : '';
    add('ok', null, `Tarefa criada${plan.publish ? ' e publicada' : ' (despublicada)'}.${open}`);
  } else if (r.createError) add('error', `Tarefa não criada: ${r.createError}`);
  else if (r.current === 'create') add('busy', 'Criando a tarefa...');
  else add('wait', 'Na fila.');

  if (plan.sis) {
    if (r.sisDone) add('ok', 'Sincronizada com SIS.');
    else if (r.sisError) add('warn', `SIS não ligado: ${r.sisError}`);
    else if (r.current === 'sis') add('busy', 'Ligando o SIS...');
    else if (r.assignmentId || !r.createError) add('wait', 'SIS: aguardando.');
  }

  if (plan.module && plan.task.module) {
    const name = plan.task.module.name;
    if (r.moduleDone) {
      add('ok', r.moduleCreated
        ? `Módulo "${name}" criado com a tarefa${r.modulePublished ? ' e publicado' : ''}.`
        : `Tarefa colocada no fim do módulo "${name}".`);
    } else if (r.moduleError) add('warn', `Módulo: ${r.moduleError}`);
    else if (r.current === 'module') add('busy', 'Colocando no módulo...');
    else if (r.assignmentId || !r.createError) add('wait', 'Módulo: aguardando.');
  }

  box.innerHTML = lines.join('');
  box.querySelectorAll('a[data-url]').forEach(a => {
    a.addEventListener('click', () => chrome.tabs.create({ url: a.dataset.url }));
  });
  return box;
}

const runTargets  = () => (_dests || []).filter(d => !d.error && d.checked);
const pendingRuns = () => (_dests || []).filter(d => _run[d.courseId] && _run[d.courseId].status !== 'ok');

function syncRunBtn() {
  const btn = $('btn-run');
  if (_phase === 'running') return;   // o laço da criação cuida do botão
  if (!_dests || _phase === 'checking') { btn.hidden = true; return; }
  if (_phase === 'done') {
    const n = pendingRuns().length;
    btn.hidden      = !n;
    btn.disabled    = false;
    btn.textContent = `↻  Tentar de novo ${n > 1 ? `os ${n} cursos que não terminaram` : 'o curso que não terminou'}`;
    return;
  }
  const n = runTargets().length;
  btn.hidden      = false;
  btn.disabled    = !n;
  btn.textContent = n ? `✅  Criar a tarefa em ${n} curso${n > 1 ? 's' : ''}` : 'Marque ao menos um curso';
}

function openConfirm() {
  const targets = runTargets();
  if (!targets.length) return;
  const o = opts;
  const parts = [
    kv('Tarefa', _task.name),
    kv('Origem', `#${_src.id} · ${_src.name}`),
    kv('Publicada', o.publish ? 'sim — os alunos podem ser notificados' : 'não'),
    kv('SIS', o.sis ? 'sincronizar' : 'não'),
    kv('Datas', o.dates === 'keep' ? 'as da origem' : 'sem datas'),
  ];
  for (const d of targets) {
    const g = d.groups.find(x => x.id === d.groupId);
    const m = moduleNote(d, o);
    parts.push(
      `<div class="cd-course"><b>#${esc(d.courseId)}</b> ${esc(d.name)}` +
      `<div class="note">Grupo: ${esc(g ? g.name : 'grupo padrão do Canvas')}</div>` +
      `<div class="note">${esc(m.text)}</div></div>`);
  }
  $('confirm-detail').innerHTML = parts.join('');
  $('modal-confirm').hidden = false;
}

async function startRun() {
  $('modal-confirm').hidden = true;
  const targets = runTargets();
  if (!targets.length) return;
  let tab;
  try {
    tab = await canvasTab();
  } catch (err) {
    setStatus('check-status', '✗ ' + err.message, RED);
    return;
  }
  _plan = { ...opts, tabId: tab.id, sourceId: _src.id, task: _task };
  _run  = Object.fromEntries(targets.map(d => [d.courseId, { status: 'pending' }]));
  await runAll(targets);
}

async function retryRun() {
  const targets = pendingRuns();
  if (!targets.length) return;
  try {
    _plan.tabId = (await canvasTab()).id;   // a aba usada antes pode ter sido fechada
  } catch (err) {
    setStatus('check-status', '✗ ' + err.message, RED);
    return;
  }
  targets.forEach(d => { _run[d.courseId].status = 'pending'; });
  await runAll(targets);
}

async function runAll(targets) {
  _phase = 'running';
  syncUI();
  const btn = $('btn-run');
  btn.hidden = false;
  $('run-summary').hidden = true;
  setStatus('check-status', 'Mantenha o painel aberto e a aba do Canvas no Canvas até terminar.', ORANGE);
  for (let i = 0; i < targets.length; i++) {
    busyBtn(btn, `Criando... ${i + 1} de ${targets.length}`);
    await runCourse(targets[i]);
    renderDests();
  }
  btn.disabled = false;
  _phase = 'done';
  setStatus('check-status', '');
  syncUI();
  renderDests();
  renderSummary();
}

function renderSummary() {
  const runs = Object.values(_run);
  const box  = $('run-summary');
  if (_phase !== 'done' || !runs.length) { box.hidden = true; return; }
  const ok   = runs.filter(r => r.status === 'ok').length;
  const warn = runs.filter(r => r.status === 'warn').length;
  const err  = runs.filter(r => r.status === 'error').length;
  const lines = [];
  if (ok)   lines.push(`<div style="color:${GREEN}">✅ ${ok} curso(s) concluído(s).</div>`);
  if (warn) lines.push(`<div style="color:#fbbf24">⚠️ ${warn} com a tarefa criada, mas com um passo pendente (veja o cartão).</div>`);
  if (err)  lines.push(`<div style="color:${RED}">❌ ${err} sem a tarefa criada.</div>`);
  lines.push('<div class="muted">Para outra cópia, escolha a tarefa ou os cursos e clique em "Conferir destinos".</div>');
  box.innerHTML = lines.join('');
  box.hidden = false;
}

// ── Interface ─────────────────────────────────────────────────────────
function syncUI() {
  const locked = _phase === 'running' || _phase === 'checking';
  ['src-input', 'btn-src-list', 'btn-src-tab', 'task-filter', 'dst-input', 'btn-dst-tab',
   'opt-module', 'opt-module-existing', 'opt-publish', 'opt-sis', 'opt-dates', 'btn-check']
    .forEach(id => { if (!$(id).querySelector?.('.spinner')) $(id).disabled = locked; });
  $('opt-module-extra').hidden = !opts.module;
  syncRunBtn();
}

async function loadOpts() {
  try {
    const { opts: saved } = await chrome.storage.local.get('opts');
    opts = { ...OPT_DEFAULTS, ...(saved || {}) };
  } catch { /* fica com o padrão */ }
  $('opt-module').checked          = opts.module;
  $('opt-module-existing').value   = opts.moduleExisting;
  $('opt-publish').checked         = opts.publish;
  $('opt-sis').checked             = opts.sis;
  $('opt-dates').value             = opts.dates;
}

function saveOpts() {
  opts = {
    module:         $('opt-module').checked,
    moduleExisting: $('opt-module-existing').value,
    publish:        $('opt-publish').checked,
    sis:            $('opt-sis').checked,
    dates:          $('opt-dates').value,
  };
  chrome.storage.local.set({ opts }).catch(() => {});
  syncUI();
  // As notas de módulo dos cartões dependem das opções.
  if (_dests && !Object.keys(_run).length) renderDests();
}

function onSourceInput() {
  _srcGen++;
  clearSource();
  setStatus('src-status', '');
}

function onDestInput() {
  _dstGen++;
  clearDests();
}

// ── Boot ──────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  $('version-label').textContent = 'v' + chrome.runtime.getManifest().version;
  await loadOpts();

  $('src-input').addEventListener('input', onSourceInput);
  $('src-input').addEventListener('keydown', e => { if (e.key === 'Enter') doListSource(); });
  $('btn-src-list').addEventListener('click', doListSource);
  $('btn-src-tab').addEventListener('click', async () => {
    const id = await tabCourseId();
    if (!id) { setStatus('src-status', '✗ A aba ativa não é de um curso do Canvas.', RED); return; }
    $('src-input').value = id;
    onSourceInput();
    doListSource();
  });
  $('task-filter').addEventListener('input', () => { if (_src) renderTaskList(); });

  $('dst-input').addEventListener('input', onDestInput);
  $('btn-dst-tab').addEventListener('click', async () => {
    const id = await tabCourseId();
    if (!id) { setStatus('check-status', '✗ A aba ativa não é de um curso do Canvas.', RED); return; }
    if (_src && id === _src.id) { setStatus('check-status', '✗ Esse é o curso de origem — ele não pode ser destino.', RED); return; }
    const input    = $('dst-input');
    const existing = parseCourseIds(input.value);
    if (existing.includes(id)) return;
    if (existing.length >= MAX_COURSES) { setStatus('check-status', `✗ Limite de ${MAX_COURSES} cursos atingido.`, RED); return; }
    input.value = (input.value.trim() ? input.value.trim() + '\n' : '') + id;
    onDestInput();   // valor trocado por código não dispara o evento "input"
  });

  ['opt-module', 'opt-module-existing', 'opt-publish', 'opt-sis', 'opt-dates']
    .forEach(id => $(id).addEventListener('change', saveOpts));

  $('btn-check').addEventListener('click', doCheck);
  $('btn-run').addEventListener('click', () => {
    if (_phase === 'done') retryRun();
    else openConfirm();
  });
  $('btn-confirm-cancel').addEventListener('click', () => { $('modal-confirm').hidden = true; });
  $('btn-confirm-ok').addEventListener('click', startRun);

  syncUI();
});
