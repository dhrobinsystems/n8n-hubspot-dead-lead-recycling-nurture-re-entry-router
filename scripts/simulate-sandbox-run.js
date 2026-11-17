#!/usr/bin/env node
/*
 * simulate-sandbox-run.js
 * ---------------------------------------------------------------------------
 * Offline simulator for n8n-hubspot-dead-lead-recycling-nurture-re-entry-router.
 *
 * Zero dependencies and zero network modules: only fs, path and vm are
 * required. Code-node JavaScript is taken verbatim from workflow.json and run
 * in isolated VM contexts by a small engine that follows workflow.json's
 * connections, evaluates IF / HTTP {{ expressions }} (including expression
 * header names and methods), emulates search pagination, full-response mode
 * and workflow static data. HTTP nodes are routed to in-memory HubSpot and
 * enrichment-provider mocks that evaluate real search filters, enforce
 * sequence-enrollment rules and record every write.
 *
 * Verifies: structure and static safety, safe defaults and config validation,
 * fixture parity, cooling-off arithmetic and the latest-touch clock, every
 * suppression and routing scenario, enrichment mapping and failures, caps,
 * live discovery queries, enrollment safety (active-enrollment check, no
 * retry), stamps written only on change, rerun idempotency, nurture list adds
 * and fail-closed paths.
 *
 * Usage:  node scripts/simulate-sandbox-run.js [--quiet]
 * Exit:   0 when every check passes, 1 otherwise.
 * Output: sim-output/ (git-ignored): routing report and run reports.
 *
 * Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

globalThis.fetch = () => { throw new Error('Network access is not allowed in the simulator'); };

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, 'workflow.json');
const FIXTURE_PATH = path.join(ROOT, 'sample-payloads', 'recycle-fixture.json');
const OUT_DIR = path.join(ROOT, 'sim-output');
const QUIET = process.argv.includes('--quiet');
const workflow = JSON.parse(fs.readFileSync(WORKFLOW_PATH, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
const byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

let passed = 0, failed = 0;
const failures = [];
function check(label, cond, detail) {
  if (cond) { passed++; if (!QUIET) console.log(`  ✔ ${label}`); }
  else { failed++; failures.push(label + (detail ? ` -- ${detail}` : '')); console.log(`  ✘ ${label}${detail ? `\n      ${detail}` : ''}`); }
}
const section = (t) => { if (!QUIET) console.log(`\n▶ ${t}`); };

// ===================================================================== mocks
const TOKENS = {
  HUBSPOT_PRIVATE_APP_TOKEN: 'sim-placeholder-hubspot-token-0000',
  ENRICHMENT_API_KEY: 'sim-placeholder-enrichment-key-0000',
};
const ENRICH_URL = 'https://enrichment.example.com/v1/verify';
class HttpError extends Error { constructor(status, message, body) { super(`${status} - ${message}`); this.status = status; this.body = body; } }
const DAY = 86400000;
// opts: nowMs (resolves @daysAgo), enrich(email) override, failEnrich, failSearch, fakeTotal, failUpdate, failEnroll(contactId)
function makeMocks(opts = {}) {
  const now = opts.nowMs || Date.parse('2026-11-17T09:00:00.000Z');
  const resolve = (v) => { if (typeof v !== 'string') return v; const m = v.match(/^@daysAgo:(-?\d+)(:date)?$/); if (!m) return v; const iso = new Date(now - Number(m[1]) * DAY).toISOString(); return m[2] ? iso.slice(0, 10) : iso; };
  const props = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, resolve(v)]));
  const contacts = new Map(clone(opts.contacts || fixture.contacts).map((c) => [c.id, props(c.properties)]));
  const deals = new Map(clone(opts.deals || fixture.deals).map((d) => [d.id, props(d.properties)]));
  const A = clone(opts.associations || fixture.associations);
  const active = new Map(Object.entries(clone(opts.activeEnrollments || fixture.activeEnrollments)));
  const lists = {};
  const state = { calls: [], contacts, deals, active, lists, enrollments: [], updates: [], enrichCalls: [] };
  const toMs = (v) => { const s = String(v ?? ''); if (!s) return null; if (/^\d{12,14}$/.test(s)) return Number(s); const t = Date.parse(s); return Number.isFinite(t) ? t : null; };
  const match = (p, f) => { const v = p[f.propertyName]; if (f.operator === 'IN') return f.values.includes(String(v ?? '')); const a = toMs(v); if (a === null) return false; return f.operator === 'LTE' ? a <= Number(f.value) : f.operator === 'GTE' ? a >= Number(f.value) : false; };
  function search(map, body) {
    const all = [...map.entries()].filter(([, p]) => body.filterGroups.some((g) => g.filters.every((f) => match(p, f)))).sort((a, b) => Number(a[0]) - Number(b[0]));
    const start = Number(body.after || 0);
    const page = all.slice(start, start + body.limit).map(([id, p]) => ({ id, properties: Object.fromEntries(body.properties.map((k) => [k, p[k] ?? null])) }));
    return { total: opts.fakeTotal || all.length, results: page, ...(start + body.limit < all.length ? { paging: { next: { after: String(start + body.limit) } } } : {}) };
  }
  function handle({ method, url, headers, body, node }) {
    const u = new URL(url);
    state.calls.push({ node, method, host: u.host, path: u.pathname, query: u.search, headers: clone(headers), body: clone(body) });
    if (u.origin + u.pathname === ENRICH_URL) {
      if (headers.Authorization !== `Bearer ${TOKENS.ENRICHMENT_API_KEY}`) throw new HttpError(401, 'bad enrichment key');
      state.enrichCalls.push(clone(body));
      if (opts.failEnrich) throw new HttpError(503, 'enrichment unavailable');
      const custom = opts.enrich ? opts.enrich(body.email) : undefined;
      if (custom !== undefined) return custom;
      const r = fixture.enrichment[body.email];
      if (!r) return { email_status: 'unknown' };
      if (r.__error) throw new Error(r.__error);
      return clone(r);
    }
    if (u.host !== 'api.hubapi.com') throw new HttpError(502, 'unmocked host ' + u.host);
    if (headers.Authorization !== `Bearer ${TOKENS.HUBSPOT_PRIVATE_APP_TOKEN}`) throw new HttpError(401, 'bad token');
    const p = u.pathname;
    if (method === 'POST' && p === '/crm/v3/objects/deals/search') { if (opts.failSearch) throw new HttpError(500, 'search down'); return search(deals, body); }
    if (method === 'POST' && p === '/crm/v3/objects/contacts/search') return search(contacts, body);
    if (method === 'POST' && p === '/crm/v4/associations/deals/contacts/batch/read') return { status: 'COMPLETE', results: body.inputs.filter((i) => (A.dealContacts[i.id] || []).length).map((i) => ({ from: { id: i.id }, to: A.dealContacts[i.id].map((c) => ({ toObjectId: Number(c), associationTypes: [] })) })) };
    if (method === 'POST' && p === '/crm/v4/associations/contacts/deals/batch/read') return { status: 'COMPLETE', results: body.inputs.filter((i) => (A.contactDeals[i.id] || []).length).map((i) => ({ from: { id: i.id }, to: A.contactDeals[i.id].map((d) => ({ toObjectId: Number(d), associationTypes: [] })) })) };
    if (method === 'POST' && (p === '/crm/v3/objects/contacts/batch/read' || p === '/crm/v3/objects/deals/batch/read')) {
      if (body.inputs.length > 100) throw new HttpError(400, 'batch > 100');
      const map = p.includes('contacts') ? contacts : deals;
      return { status: 'COMPLETE', results: body.inputs.filter((i) => map.has(i.id)).map((i) => ({ id: i.id, properties: Object.fromEntries(body.properties.map((k) => [k, map.get(i.id)[k] ?? null])) })) };
    }
    let m = p.match(/^\/automation\/v4\/sequences\/enrollments\/contact\/(\d+)$/);
    if (m && method === 'GET') { const e = active.get(m[1]); if (!e) throw new HttpError(404, 'no active enrollment', { status: 'error', message: 'Not found' }); return { id: e.id, sequenceId: e.sequenceId, enrolledAt: e.enrolledAt, toEmail: contacts.get(m[1]).email }; }
    if (method === 'POST' && p === '/automation/v4/sequences/enrollments') {
      const userId = u.searchParams.get('userId');
      if (!userId) throw new HttpError(400, 'userId required', { message: 'userId required' });
      if (!body.contactId || !body.sequenceId || !body.senderEmail) throw new HttpError(400, 'missing field', { message: 'contactId, sequenceId and senderEmail are required' });
      if (opts.failEnroll && opts.failEnroll(body.contactId)) throw new HttpError(400, 'sender inbox not connected', { message: 'The sender inbox is not connected' });
      if (active.has(body.contactId)) throw new HttpError(400, 'already enrolled', { message: 'Contact is already enrolled in a sequence' });
      const e = { id: String(82000000 + state.enrollments.length), sequenceId: body.sequenceId, enrolledAt: new Date(now).toISOString(), userId, senderEmail: body.senderEmail };
      active.set(body.contactId, e); state.enrollments.push({ contactId: body.contactId, ...e });
      return { id: e.id, enrolledAt: e.enrolledAt, sequenceId: body.sequenceId, toEmail: contacts.get(body.contactId).email };
    }
    if (method === 'POST' && p === '/crm/v3/objects/contacts/batch/update') {
      if (opts.failUpdate) throw new HttpError(500, 'update outage');
      if (body.inputs.length > 100) throw new HttpError(400, 'batch > 100');
      for (const i of body.inputs) { if (!contacts.has(i.id)) throw new HttpError(404, 'missing ' + i.id); Object.assign(contacts.get(i.id), i.properties); state.updates.push({ id: i.id, properties: clone(i.properties) }); }
      return { status: 'COMPLETE', results: body.inputs.map((i) => ({ id: i.id, properties: i.properties })) };
    }
    m = p.match(/^\/crm\/v3\/lists\/(\d+)\/memberships\/add$/);
    if (m && method === 'PUT') { lists[m[1]] = lists[m[1]] || new Set(); const added = body.filter((id) => !lists[m[1]].has(id)); body.forEach((id) => lists[m[1]].add(id)); return { recordIdsAdded: added, recordIdsMissing: [] }; }
    throw new HttpError(404, `unmocked route ${method} ${p}`);
  }
  return { state, handle };
}
// ==================================================================== engine
function evalExpr(template, ctx) {
  if (typeof template !== 'string' || !template.startsWith('=')) return template;
  const t = template.slice(1);
  const run = (expr) => vm.runInNewContext(`(${expr})`, { ...ctx, encodeURIComponent, JSON, String, Object, Number }, { timeout: 2000 });
  const single = t.match(/^\{\{([\s\S]*)\}\}$/);
  if (single && !single[1].includes('}}')) return run(single[1]);
  return t.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => { const v = run(e); return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v); });
}
function runWorkflow({ trigger = 'manual', webhookItem, env = {}, mocks, staticData = {} }) {
  const runData = {};
  let webhookResponse = null;
  const envProxy = new Proxy({}, { get(_t, k) { if (env === 'BLOCKED') throw new Error('access to env vars denied'); return typeof k === 'string' ? env[k] : undefined; } });
  const accessor = (name) => {
    const runs = runData[name];
    if (!runs || !runs.length) throw new Error(`Referenced node "${name}" has not executed`);
    const items = (runs[runs.length - 1][0] || []).map(clone);
    return { first: () => items[0], last: () => items[items.length - 1], all: () => items, item: items[0] };
  };
  const ctxFor = (item) => ({ $json: clone(item.json), $: accessor, $env: envProxy });
  function exec(name, items) {
    const node = byName[name];
    let outputs;
    switch (node.type) {
      case 'n8n-nodes-base.manualTrigger': case 'n8n-nodes-base.webhook': case 'n8n-nodes-base.scheduleTrigger':
        outputs = [items]; break;
      case 'n8n-nodes-base.respondToWebhook':
        webhookResponse = { statusCode: node.parameters.options.responseCode || 200, body: JSON.parse(evalExpr(node.parameters.responseBody, ctxFor(items[0]))) };
        outputs = [items]; break;
      case 'n8n-nodes-base.code': {
        const sandbox = {
          $input: { first: () => clone(items[0]), all: () => items.map(clone), item: clone(items[0]) },
          $env: envProxy, $: accessor, $getWorkflowStaticData: () => staticData,
          require: (m) => { throw new Error(`Cannot find module '${m}'`); },
          console: { log() {}, warn() {}, error() {} },
        };
        const res = vm.runInNewContext(`(() => {\n${node.parameters.jsCode}\n})()`, sandbox, { timeout: 20000, filename: `${name}.js` });
        if (!Array.isArray(res)) throw new Error(`Code node "${name}" did not return an array`);
        outputs = [res.map((i) => clone({ json: i.json }))];
        break;
      }
      case 'n8n-nodes-base.if': {
        const t = [], f = [];
        for (const it of items) (evalExpr(node.parameters.conditions.conditions[0].leftValue, ctxFor(it)) === true ? t : f).push(it);
        outputs = [t, f]; break;
      }
      case 'n8n-nodes-base.httpRequest': {
        const out = [];
        const pg = node.parameters.options && node.parameters.options.pagination && node.parameters.options.pagination.pagination;
        for (const it of items) {
          const c = ctxFor(it);
          let url = evalExpr(node.parameters.url, c);
          const headers = Object.fromEntries((node.parameters.headerParameters?.parameters || []).map((h) => [evalExpr(h.name, c), evalExpr(h.value, c)]));
          const full = !!(node.parameters.options && node.parameters.options.response && node.parameters.options.response.response && node.parameters.options.response.response.fullResponse);
          const neverError = full && node.parameters.options.response.response.neverError;
          let body = node.parameters.sendBody ? JSON.parse(evalExpr(node.parameters.jsonBody, c)) : undefined;
          const method = evalExpr(node.parameters.method || 'GET', c);
          const send = () => { if (!full) return mocks.handle({ method, url, headers, body, node: name }); try { return { statusCode: 200, headers: {}, body: mocks.handle({ method, url, headers, body, node: name }) }; } catch (e) { if (neverError && e.status) return { statusCode: e.status, headers: {}, body: e.body || { message: e.message } }; throw e; } };
          try {
            if (!pg) { out.push({ json: send() }); continue; }
            for (let n = 0; n < Number(evalExpr(pg.maxRequests, c)); n++) {
              const resp = send();
              out.push({ json: resp });
              const rc = { ...c, $response: { body: resp } };
              if (evalExpr(pg.completeExpression, rc) === true) break;
              for (const prm of pg.parameters.parameters) {
                const v = evalExpr(prm.value, rc);
                if (prm.type === 'body') body = { ...body, [prm.name]: v };
                if (prm.type === 'qs') { const uu = new URL(url); uu.searchParams.set(prm.name, v); url = uu.toString(); }
              }
            }
          } catch (e) {
            if (node.onError === 'continueRegularOutput') out.push({ json: { error: { message: e.message, status: e.status } } });
            else throw Object.assign(new Error(`${name}: ${e.message}`), { node: name });
          }
        }
        outputs = [out]; break;
      }
      default: throw new Error(`Engine does not support ${node.type}`);
    }
    (runData[name] = runData[name] || []).push(outputs.map((o) => (o || []).map(clone)));
    const conns = (workflow.connections[name] || {}).main || [];
    outputs.forEach((o, idx) => { if (o && o.length) for (const cn of conns[idx] || []) exec(cn.node, o); });
  }
  let error = null;
  try {
    if (trigger === 'schedule') exec('Daily Recycle Run (06:41)', [{ json: { timestamp: '2026-11-17T06:41:00.000+00:00' } }]);
    else exec('Manual Test Trigger', [{ json: {} }]);
  } catch (e) { error = e; }
  const last = (n) => (runData[n] ? runData[n][runData[n].length - 1][0].map((i) => i.json) : undefined);
  return { runData, error, last, mocks, staticData, webhookResponse };
}


// ============================================================== helpers
const NOW = '2026-11-17T09:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const FOOT = 'Full text: DISCLAIMER.md · Licensed under the MIT License. License: MIT © 2026 dhRobin Systems · Provided as-is, see the disclaimer.';
const SR = fixture.sandboxRouting;
const ROUTING = { SEQUENCE_MAP_JSON: JSON.stringify(SR.sequenceMap), OWNER_SENDER_MAP_JSON: JSON.stringify(SR.ownerSenders), DEFAULT_SENDER_USER_ID: SR.defaultSender.userId, DEFAULT_SENDER_EMAIL: SR.defaultSender.senderEmail, NURTURE_LIST_ID: SR.nurtureListId };
const ENRICH = { ENRICHMENT_MODE: 'http', ENRICHMENT_ENABLED: 'true', ENRICHMENT_API_URL: ENRICH_URL, ENRICHMENT_ALLOWED_HOSTS: 'enrichment.example.com' };
const LIVE = { SANDBOX_MODE: 'false', NOW_OVERRIDE: NOW, ...TOKENS, ...ROUTING, ...ENRICH };
const ARMED = { ...LIVE, DRY_RUN: 'false', HUBSPOT_WRITES_ENABLED: 'true', SEQUENCE_ENROLLMENT_ENABLED: 'true', NURTURE_ROUTING_ENABLED: 'true' };
const SB = (env = {}) => runWorkflow({ env: { NOW_OVERRIDE: NOW, ...env }, mocks: makeMocks(), staticData: {} });
const run = (env, mocks) => runWorkflow({ env, mocks, staticData: {} });
const routeOf = (r) => r.last('Route Re-Entry')[0];
const dec = (r, id) => routeOf(r).decisions.find((d) => d.id === String(id));
const reportOf = (r) => r.last('Recycle Run Report')[0];
const outcome = (r, id) => r.last('Build Contact Updates')[0].outcomes.find((o) => o.contactId === String(id));

// ====================================================================== main
(function main() {
  console.log('n8n-hubspot-dead-lead-recycling-nurture-re-entry-router :: offline simulator');
  console.log(`workflow: workflow.json (${workflow.nodes.length} nodes)`);
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ----------------------------------------------------------- 1. structure
  section('1. Workflow structure and static safety checks');
  const names = workflow.nodes.map((n) => n.name);
  check('Node names are unique', new Set(names).size === names.length);
  check('Workflow is inactive on import', workflow.active === false);
  const bad = [];
  for (const [s, c] of Object.entries(workflow.connections)) { if (!byName[s]) bad.push(s); for (const b of c.main || []) for (const x of b) if (!byName[x.node]) bad.push(`${s}->${x.node}`); }
  check('All connections reference existing nodes', bad.length === 0, bad.join(', '));
  const ifs = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.if');
  check(`All ${ifs.length} IF nodes wire both outputs`, ifs.every((n) => (workflow.connections[n.name]?.main || []).length === 2 && workflow.connections[n.name].main.every((b) => b.length)));
  const reach = new Set();
  const walk = (n) => { if (reach.has(n)) return; reach.add(n); for (const b of workflow.connections[n]?.main || []) for (const c of b) walk(c.node); };
  ['Manual Test Trigger', 'Daily Recycle Run (06:41)'].forEach(walk);
  const unreach = workflow.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !reach.has(n.name)).map((n) => n.name);
  check('Every functional node is reachable from a trigger', unreach.length === 0, unreach.join(', '));
  const http = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.httpRequest');
  const hs = http.filter((n) => n.name.startsWith('HubSpot:'));
  check(`${hs.length} HubSpot nodes authenticate only via Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}`, hs.length === 8 && hs.every((n) => n.parameters.headerParameters.parameters.find((h) => h.name === 'Authorization').value === '=Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}'));
  const en = byName['Enrichment API: Verify Contact'];
  check('Enrichment key only via $env.ENRICHMENT_API_KEY in a header; failures continue (HOLD)', /\$env\.ENRICHMENT_API_KEY/.test(en.parameters.headerParameters.parameters[0].value) && en.onError === 'continueRegularOutput');
  check('Sequence enrollment has NO automatic retry (an enrollment sends email)', !byName['HubSpot: Enroll in Sequence'].retryOnFail && byName['HubSpot: Enroll in Sequence'].onError === 'continueRegularOutput');
  check('Discovery reads stop the run on failure (fail closed)', ['HubSpot: Search Closed-Lost Deals', 'HubSpot: Search Disqualified Contacts', 'HubSpot: Read Contacts & Deal Links', 'HubSpot: Batch Read Associated Deals'].every((n) => !byName[n].onError));
  check('No stored n8n credentials', workflow.nodes.every((n) => !n.credentials));
  const codeSrc = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.code').map((n) => [n.name, n.parameters.jsCode]);
  const writers = codeSrc.filter(([, s]) => /batch\/update|memberships\/add|sequences\/enrollments\?/.test(s.replace(/\/\/.*$/gm, ''))).map(([n]) => n).sort();
  check('Only "Build Contact Updates" and "Build Sequence Enrollments" build write requests', writers.join() === 'Build Contact Updates,Build Sequence Enrollments', writers.join());
  check(`Every Code node starts with the license footer line (${codeSrc.length} nodes)`, codeSrc.every(([, s]) => s.startsWith(`// ${FOOT}\n`)));
  check('Simulator header carries the license footer', fs.readFileSync(__filename, 'utf8').includes(FOOT));
  const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
  const PAT = [[/pat-(na|eu|ap)\d?-[0-9a-f-]{20,}/i, 'HubSpot token'], [/Bearer (?!your_[a-z_]+_here)[A-Za-z0-9\-_.]{16,}/, 'literal bearer'], [/[?&](api_?key|token)=[A-Za-z0-9]{8,}/i, 'key in URL'], [/hooks\.slack\.com\/services\//, 'webhook URL'], [/\b(?!555)\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/, 'phone number (non-555)']];
  const texts = { 'workflow.json': raw };
  for (const f of ['README.md', 'DISCLAIMER.md', '.env.example', 'sample-payloads/recycle-fixture.json']) if (fs.existsSync(path.join(ROOT, f))) texts[f] = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const hits = [];
  for (const [f, t] of Object.entries(texts)) for (const [re, l] of PAT) if (re.test(t)) hits.push(`${l} in ${f}`);
  check('No tokens, keys in URLs or real-looking phone numbers in shipped files', hits.length === 0, hits.join(', '));
  const emails = [...new Set((raw + texts['sample-payloads/recycle-fixture.json']).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [])];
  check('Every email in workflow / fixture uses example.com', emails.length > 0 && emails.every((e) => /@example\.com$/i.test(e)), emails.join(','));
  const exprErr = [];
  const visit = (v, w) => { if (typeof v === 'string' && v.startsWith('=')) for (const mm of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) { try { new Function('$json', '$', '$env', '$response', `return (${mm[1]});`); } catch (e) { exprErr.push(`${w}: ${e.message}`); } } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, `${w}.${k}`); };
  workflow.nodes.forEach((n) => visit(n.parameters, n.name));
  check('Every {{ expression }} parses as JavaScript', exprErr.length === 0, exprErr.join('; '));
  const cErr = [];
  for (const [n, s] of codeSrc) { try { new vm.Script(`(() => {\n${s}\n})`); } catch (e) { cErr.push(`${n}: ${e.message}`); } }
  check('Every Code node compiles', cErr.length === 0, cErr.join('; '));
  check('Code nodes call no require() and read no tokens from $env (outside Config)', codeSrc.every(([, s]) => !/\brequire\s*\(/.test(s)) && codeSrc.filter(([n]) => n !== 'Config & Safety Gate').every(([, s]) => !/\$env/.test(s.replace(/\/\/.*$/gm, ''))));

  // ------------------------------------------------------ 2. config
  section('2. Safe defaults and config validation');
  const cfgOf = (env) => { const r = runWorkflow({ env, mocks: makeMocks() }); return { r, c: r.last('Config & Safety Gate') && r.last('Config & Safety Gate')[0].config }; };
  const { c: d0 } = cfgOf({ NOW_OVERRIDE: NOW });
  check('Empty env -> SANDBOX + DRY_RUN; stamps, sequences, nurture and enrichment all blocked', d0.sandboxMode && d0.dryRun && !d0.writes.hubspot.allowed && !d0.writes.sequence.allowed && !d0.writes.nurture.allowed && !d0.enrichment.allowed);
  check('Defaults: 120-day cooling-off, 730-day lookback, re-evaluate every 30 days, max 2 recycles', d0.cooling.days === 120 && d0.cooling.lookbackDays === 730 && d0.cooling.reevaluateDays === 30 && d0.cooling.maxRecycles === 2);
  check('Cooling cutoff = now - 120 days; closed-lost search uses closedate LTE cutoff and GTE lookback start', d0.cooling.cutoffMs === NOW_MS - 120 * DAY && d0.hubspot.searches.deals.body.filterGroups[0].filters[1].value === String(NOW_MS - 120 * DAY) && d0.hubspot.searches.deals.body.filterGroups[0].filters[2].value === String(NOW_MS - 850 * DAY));
  check('Defaults: verified email required for outbound; risky emails not nurtured; job title not overwritten', d0.rules.requireVerifiedForOutbound && !d0.rules.nurtureAllowRisky && !d0.rules.updateJobTitle);
  const { c: typo } = cfgOf({ NOW_OVERRIDE: NOW, SANDBOX_MODE: 'flase', DRY_RUN: 'nah', SEQUENCE_ENROLLMENT_ENABLED: 'please' });
  check('Typos keep SANDBOX / DRY_RUN on and enrollment off', typo.sandboxMode && typo.dryRun && !typo.writes.sequence.allowed);
  const { c: blk } = cfgOf('BLOCKED');
  check('Blocked $env -> sandbox, all writes blocked', blk.envBlocked && blk.sandboxMode && !blk.writes.hubspot.allowed);
  const t1 = runWorkflow({ env: { SANDBOX_MODE: 'false' }, mocks: makeMocks() });
  check('Live without HUBSPOT_PRIVATE_APP_TOKEN is refused before any call', t1.error && /HUBSPOT_PRIVATE_APP_TOKEN/.test(t1.error.message) && t1.mocks.state.calls.length === 0);
  const { c: e1 } = cfgOf({ NOW_OVERRIDE: NOW, ENRICHMENT_MODE: 'http', ENRICHMENT_API_URL: 'https://enrichment.attacker.example/v1?key=1', ENRICHMENT_ALLOWED_HOSTS: 'enrichment.example.com' });
  check('Enrichment URL with a query string or a non-allowlisted host is a config error', e1.configErrors.some((e) => /ENRICHMENT_API_URL/.test(e)) && !e1.enrichment.allowed);
  const { c: e2 } = cfgOf({ NOW_OVERRIDE: NOW, SEQUENCE_MAP_JSON: '{"LOST":"x"}', OWNER_SENDER_MAP_JSON: '{"1":{"userId":"a"}}', OUTBOUND_TITLE_REGEX: '(a+)+$', COOLING_OFF_DAYS: '0', NURTURE_LIST_ID: 'list-1', SET_LEAD_STATUS_ON_ROUTE: 'open please' });
  check('Invalid sequence map, sender map, ReDoS regex, cooling days, list id and lead status are config errors', ['SEQUENCE_MAP_JSON', 'OWNER_SENDER_MAP_JSON', 'OUTBOUND_TITLE_REGEX', 'COOLING_OFF_DAYS', 'NURTURE_LIST_ID', 'SET_LEAD_STATUS_ON_ROUTE'].every((k) => e2.configErrors.some((e) => e.includes(k))), JSON.stringify(e2.configErrors));
  const { r: sr } = cfgOf({ ...ARMED });
  check('Config output contains no token or key (only "is set" booleans)', Object.values(TOKENS).every((t) => !JSON.stringify(sr.runData['Config & Safety Gate']).includes(t)) && sr.last('Config & Safety Gate')[0].config.enrichment.keySet === true);
  const { c: g1 } = cfgOf({ ...ARMED, HUBSPOT_WRITES_ENABLED: 'false' });
  check('Sequence and nurture routing require HUBSPOT_WRITES_ENABLED too', !g1.writes.sequence.allowed && !g1.writes.nurture.allowed);

  // ---------------------------------------------------- 3. fixture
  section('3. Fixture parity and synthetic data');
  const emb = byName['Load Synthetic Recycle Fixture'].parameters.jsCode.match(/const FIXTURE = ([\s\S]*?);\nconst DAY/);
  let parity = false;
  try { parity = JSON.stringify(JSON.parse(emb[1])) === JSON.stringify(fixture); } catch (e) { parity = false; }
  check('Fixture embedded in workflow.json equals sample-payloads/recycle-fixture.json', parity);
  check('Fixture flagged synthetic; all people are "Example" at example.com; dates relative', fixture._meta.synthetic && fixture.contacts.every((c) => c.properties.lastname === 'Example') && JSON.stringify(fixture).includes('@daysAgo:'));

  // ------------------------------------------------- 4. sandbox e2e
  section('4. Sandbox end-to-end: cooling-off, suppression, verification, routing');
  const sb = SB();
  check('Sandbox run completes with zero HTTP calls', !sb.error && sb.mocks.state.calls.length === 0, sb.error && sb.error.message);
  const expected = {
    51000001: ['OUTBOUND', 'SEQUENCE_CLOSED_LOST'], 51000002: ['NURTURE', 'NURTURE_CLOSED_LOST'], 51000004: ['NURTURE', 'NURTURE_CLOSED_LOST'], 51000005: ['SUPPRESS', 'LOST_REASON_EXCLUDED'],
    51000006: ['SUPPRESS', 'OPEN_DEAL'], 51000007: ['COOLING', 'COOLING_OFF'], 51000009: ['SUPPRESS', 'LEFT_COMPANY'], 51000010: ['SUPPRESS', 'EMAIL_INVALID_VERIFIED'],
    51000011: ['SUPPRESS', 'UNSUBSCRIBED'], 51000012: ['SUPPRESS', 'EMAIL_INVALID_HUBSPOT'], 51000013: ['SUPPRESS', 'LIFECYCLE_EXCLUDED'], 51000014: ['OUTBOUND', 'SEQUENCE_DISQUALIFIED'],
    51000015: ['SUPPRESS', 'TITLE_EXCLUDED'], 51000016: ['HOLD', 'NO_REFERENCE_DATE'], 51000017: ['HOLD', 'ENRICHMENT_FAILED'], 51000018: ['SUPPRESS', 'MAX_RECYCLES_REACHED'],
    51000019: ['SKIP', 'RECENTLY_EVALUATED'], 51000020: ['SUPPRESS', 'OFF_PERSONA'], 51000021: ['HOLD', 'EMAIL_RISKY'], 51000022: ['SUPPRESS', 'DO_NOT_RECYCLE'],
    51000023: ['OUTBOUND', 'SEQUENCE_DISQUALIFIED'], 51000024: ['COOLING', 'COOLING_OFF'], 51000025: ['OUTBOUND', 'SEQUENCE_DISQUALIFIED'], 51000026: ['SUPPRESS', 'NO_EMAIL'],
  };
  const got = Object.fromEntries(routeOf(sb).decisions.map((d) => [d.id, [d.decision, d.reason]]));
  check('All 24 candidates get the expected decision and reason', JSON.stringify(got) === JSON.stringify(Object.fromEntries(Object.entries(expected).map(([k, v]) => [k, v]))), JSON.stringify(Object.entries(got).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(expected[k]))));
  check('Population: 6 closed-lost deals in window (60-day-old and 1000-day-old excluded), 13 disqualified', JSON.stringify(routeOf(sb).report.population) === JSON.stringify({ closedLostDeals: 6, disqualifiedContacts: 13, candidates: 24 }) && !dec(sb, 51000003) && !dec(sb, 51000008));
  const d1 = dec(sb, 51000001);
  check('Cooling clock = LATEST touch: contacted 140 d ago beats deal closed 150 d ago (eligible 20 days ago)', d1.clockFrom === 'lastContacted' && d1.daysSinceTouch === 140 && d1.eligibleOn === new Date(NOW_MS - 20 * DAY).toISOString().slice(0, 10));
  const d7 = dec(sb, 51000007);
  check('Recent touch restarts the clock: contacted 30 d ago -> eligible in 90 days', d7.clockFrom === 'lastContacted' && d7.eligibleOn === new Date(NOW_MS + 90 * DAY).toISOString().slice(0, 10));
  check('A previous recycle restarts the clock (recycled 100 d ago -> eligible in 20 days)', dec(sb, 51000024).clockFrom === 'lastRecycled' && dec(sb, 51000024).eligibleOn === new Date(NOW_MS + 20 * DAY).toISOString().slice(0, 10));
  check('Disqualified contacts use DISQUALIFIED_DATE_PROPERTY (recycle_disqualified_at)', dec(sb, 51000014).clockFrom === 'disqualified' && dec(sb, 51000014).daysSinceTouch === 200);
  check('Outbound: closed-lost contact -> closed-lost sequence via owner sender', d1.sequenceId === '31000001' && d1.sender.userId === '62000001');
  check('Outbound: disqualified contact (owner 2) -> disqualified sequence via owner-2 sender', dec(sb, 51000014).sequenceId === '31000002' && dec(sb, 51000014).sender.senderEmail === 'blake.rep@example.com');
  check('Outbound: contact without owner uses the default sender', dec(sb, 51000025).sender.userId === '62000009');
  check('Competitor loss with a senior title is nurtured, not sequenced', dec(sb, 51000004).flags.includes('NURTURE_ONLY_LOST_REASON'));
  check('Re-verification: changed job title detected and used for routing (Head of Growth -> VP Growth)', dec(sb, 51000023).flags.includes('JOB_TITLE_CHANGED') && dec(sb, 51000023).newJobTitle === 'VP Growth');
  check('Re-verification: left the company -> suppressed and listed as a job changer', dec(sb, 51000009).flags.includes('JOB_CHANGER') && routeOf(sb).report.jobChangers.some((j) => j.contactId === '51000009'));
  check('Enrichment status mapping: deliverable -> VALID, undeliverable -> INVALID, catch_all -> RISKY', dec(sb, 51000004).emailStatus === 'VALID' && dec(sb, 51000010).emailStatus === 'INVALID' && dec(sb, 51000021).emailStatus === 'RISKY');
  check('Enrichment only for cooled-off, unsuppressed contacts (12 requests)', sb.last('Build Enrichment Requests').length === 12);
  const rpt = sb.last('Dry-Run Routing Report')[0].report;
  check('Report: 4 outbound, 2 nurture, 12 suppressed, 2 cooling, 3 held, 1 skipped', JSON.stringify(rpt.decisions) === JSON.stringify({ OUTBOUND: 4, NURTURE: 2, SUPPRESS: 12, COOLING: 2, HOLD: 3, SKIP: 1 }), JSON.stringify(rpt.decisions));
  check('Report lists cooling contacts with eligible-on dates and the clock source', rpt.cooling.length === 2 && rpt.cooling.every((c) => c.eligibleOn && c.clockFrom));
  check('Report references contacts by id only (no emails or names)', !/@example\.com|Avery|Example Co/.test(JSON.stringify(rpt)));
  check('Run status SANDBOX_DRY_RUN; static data untouched', reportOf(sb).status === 'SANDBOX_DRY_RUN' && Object.keys(sb.staticData).length === 0);
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-routing-report.json'), JSON.stringify(rpt, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT_DIR, 'sandbox-run-report.json'), JSON.stringify(reportOf(sb), null, 2) + '\n');

  // --------------------------------------------- 5. policies
  section('5. Policies, caps and options');
  const c150 = SB({ COOLING_OFF_DAYS: '150' });
  check('COOLING_OFF_DAYS=150: contact touched 140 d ago now cools; 150-d-old deal contact now eligible', dec(c150, 51000001).decision === 'COOLING' && dec(c150, 51000002).decision === 'NURTURE');
  const cap = SB({ MAX_OUTBOUND_PER_RUN: '2' });
  check('MAX_OUTBOUND_PER_RUN=2: longest-cooled 2 routed, rest DEFERRED (OUTBOUND_RUN_CAP)', routeOf(cap).decisions.filter((d) => d.decision === 'OUTBOUND').length === 2 && routeOf(cap).decisions.filter((d) => d.reason === 'OUTBOUND_RUN_CAP').length === 2 && dec(cap, 51000014).decision === 'OUTBOUND');
  const own = SB({ MAX_OUTBOUND_PER_OWNER: '1' });
  check('MAX_OUTBOUND_PER_OWNER=1: owner 61000001 gets one outbound, the other is deferred', routeOf(own).decisions.filter((d) => d.reason === 'OUTBOUND_OWNER_CAP').length === 1);
  const ec = SB({ ENRICHMENT_MAX_PER_RUN: '5' });
  check('ENRICHMENT_MAX_PER_RUN=5: 5 verified, 7 DEFERRED (ENRICHMENT_CAP), longest-cooled first', ec.last('Build Enrichment Requests').length === 5 && routeOf(ec).decisions.filter((d) => d.reason === 'ENRICHMENT_CAP').length === 7);
  const risky = SB({ NURTURE_ALLOW_RISKY: 'true' });
  check('NURTURE_ALLOW_RISKY=true: catch-all contact is nurtured', dec(risky, 51000021).decision === 'NURTURE');
  const noseq = SB({ SEQUENCE_MAP_JSON: '{"CLOSED_LOST":"31000001"}' });
  check('No sequence for a source -> outbound-qualified contact nurtured (OUTBOUND_UNAVAILABLE)', dec(noseq, 51000014).decision === 'NURTURE' && dec(noseq, 51000014).flags.includes('OUTBOUND_UNAVAILABLE'));
  const nolost = SB({ NURTURE_ONLY_LOST_REASONS_REGEX: 'none' });
  check('Configurable lost-reason rules: competitor loss can be sequenced', dec(nolost, 51000004).decision === 'OUTBOUND');
  const lc = SB({ EXCLUDE_LIFECYCLE_STAGES: 'none' });
  check('EXCLUDE_LIFECYCLE_STAGES=none -> customer is no longer excluded (still has to pass every other rule)', dec(lc, 51000013).reason !== 'LIFECYCLE_EXCLUDED');
  const re0 = SB({ REEVALUATION_INTERVAL_DAYS: '0' });
  check('REEVALUATION_INTERVAL_DAYS=0: recently evaluated contact is re-verified', dec(re0, 51000019).decision !== 'SKIP');
  const mx = SB({ MAX_RECYCLES: '3' });
  check('MAX_RECYCLES=3: contact recycled twice may recycle again', dec(mx, 51000018).decision !== 'SUPPRESS' || dec(mx, 51000018).reason !== 'MAX_RECYCLES_REACHED');
  const dqo = SB({ CLOSED_LOST_STAGES: 'none' });
  check('CLOSED_LOST_STAGES=none -> only disqualified contacts are evaluated', routeOf(dqo).report.population.closedLostDeals === 0 && !dec(dqo, 51000001));

  // --------------------------------------------- 6. live dry run
  section('6. Live dry run (mocked): read-only discovery and enrichment');
  const dm = makeMocks();
  const dr = run(LIVE, dm);
  check('Live dry run completes', !dr.error, dr.error && dr.error.message);
  const ds = dm.state.calls.find((c) => c.path === '/crm/v3/objects/deals/search');
  check('Deal search: dealstage IN closedlost, closedate LTE cutoff, GTE lookback start, limit 200', ds.body.filterGroups[0].filters[0].values.join() === 'closedlost' && ds.body.filterGroups[0].filters[1].operator === 'LTE' && ds.body.limit === 200);
  check('Contact search: hs_lead_status IN UNQUALIFIED, BAD_TIMING', dm.state.calls.find((c) => c.path === '/crm/v3/objects/contacts/search').body.filterGroups[0].filters[0].values.join() === 'UNQUALIFIED,BAD_TIMING');
  check('Dry run makes only read calls to HubSpot (search / batch read)', dm.state.calls.filter((c) => c.host === 'api.hubapi.com').every((c) => /search$|batch\/read$/.test(c.path)));
  check('Live dry-run decisions equal the sandbox decisions', JSON.stringify(routeOf(dr).decisions.map((d) => [d.id, d.decision, d.reason])) === JSON.stringify(routeOf(sb).decisions.map((d) => [d.id, d.decision, d.reason])));
  check('Enrichment called once per cooled-off contact with Bearer key; name sent only when allowed', dm.state.enrichCalls.length === 12 && dm.state.enrichCalls.every((b) => b.email && 'firstName' in b));
  const { c: px } = cfgOf({ NOW_OVERRIDE: NOW, ENRICHMENT_AUTH_PREFIX: 'Bearer' });
  const { c: px2 } = cfgOf({ NOW_OVERRIDE: NOW, ENRICHMENT_AUTH_HEADER: 'X-API-Key', ENRICHMENT_AUTH_PREFIX: 'none' });
  check('Auth prefix: "Bearer" -> "Bearer <key>"; "none" -> bare key (e.g. X-API-Key)', px.enrichment.authPrefix === 'Bearer ' && px2.enrichment.authPrefix === '' && px2.enrichment.authHeader === 'X-API-Key');
  const nn = makeMocks();
  run({ ...LIVE, ENRICHMENT_SEND_NAME: 'false' }, nn);
  check('ENRICHMENT_SEND_NAME=false: only email, company and title leave HubSpot', nn.state.enrichCalls.every((b) => !('firstName' in b) && !('lastName' in b)));
  const off = makeMocks();
  const ofr = run({ ...LIVE, ENRICHMENT_ENABLED: 'false' }, off);
  check('Enrichment off -> no enrichment calls; emails UNVERIFIED; nobody sequenced (verified email required)', off.state.enrichCalls.length === 0 && routeOf(ofr).decisions.filter((d) => d.decision === 'OUTBOUND').length === 0 && dec(ofr, 51000001).emailStatus === 'UNVERIFIED');
  const unv = run({ ...LIVE, ENRICHMENT_ENABLED: 'false', REQUIRE_VERIFIED_EMAIL_FOR_OUTBOUND: 'false' }, makeMocks());
  check('REQUIRE_VERIFIED_EMAIL_FOR_OUTBOUND=false: HubSpot-clean unverified emails may be sequenced', dec(unv, 51000001).decision === 'OUTBOUND');
  check('Dry run: zero writes, zero enrollments, status DRY_RUN', dm.state.updates.length === 0 && dm.state.enrollments.length === 0 && reportOf(dr).status === 'DRY_RUN');
  check('Tokens never appear in item data', Object.values(TOKENS).every((t) => !JSON.stringify(dr.runData).includes(t)));

  // --------------------------------------------- 7. armed
  section('7. Armed run (mocked): enrollment safety, stamps, nurture list, idempotency');
  const m = makeMocks();
  const r1 = run(ARMED, m);
  check('Armed run completes with status COMPLETED', !r1.error && reportOf(r1).status === 'COMPLETED', r1.error ? r1.error.message : JSON.stringify(reportOf(r1).enrollmentIssues));
  check('Active-enrollment check before every outbound enrollment (4 GETs)', m.state.calls.filter((c) => c.method === 'GET' && c.path.startsWith('/automation/v4/sequences/enrollments/contact/')).length === 4);
  check('3 contacts enrolled; contact already in a rep sequence skipped (IN_ACTIVE_SEQUENCE)', m.state.enrollments.length === 3 && outcome(r1, 51000025).status === 'IN_ACTIVE_SEQUENCE' && !m.state.enrollments.some((e) => e.contactId === '51000025'));
  const en1 = m.state.enrollments.find((e) => e.contactId === '51000001');
  check('Enrollment body/query: contactId, sequenceId, senderEmail, ?userId=<owner sender>', en1.sequenceId === '31000001' && en1.userId === '62000001' && en1.senderEmail === 'avery.rep@example.com');
  const c1 = m.state.contacts.get('51000001');
  check('Routed outbound stamp: RECYCLED_OUTBOUND, route SEQUENCE, count 1, routed_at, evaluated_at, email status', c1.recycle_status === 'RECYCLED_OUTBOUND' && c1.recycle_route === 'SEQUENCE' && c1.recycle_count === '1' && c1.recycle_last_routed_at === NOW && c1.recycle_last_evaluated_at === NOW && c1.recycle_email_status === 'VALID');
  const c2 = m.state.contacts.get('51000002');
  check('Routed nurture stamp: RECYCLED_NURTURE, route NURTURE; added to the static nurture list', c2.recycle_status === 'RECYCLED_NURTURE' && c2.recycle_route === 'NURTURE' && m.state.lists['71000001'].has('51000002') && m.state.lists['71000001'].size === 2);
  check('Cooling contact stamped COOLING with recycle_eligible_on; suppressed stamped with reason', m.state.contacts.get('51000007').recycle_status === 'COOLING' && m.state.contacts.get('51000007').recycle_eligible_on === dec(r1, 51000007).eligibleOn && m.state.contacts.get('51000005').recycle_reason === 'LOST_REASON_EXCLUDED');
  check('Skipped (recently evaluated) contact not written; job title NOT overwritten by default', !m.state.updates.some((u) => u.id === '51000019') && m.state.contacts.get('51000023').jobtitle === 'Head of Growth');
  check('Lead status untouched by default; every update batch <= 100 records', m.state.contacts.get('51000014').hs_lead_status === 'UNQUALIFIED' && m.state.calls.filter((c) => c.path.endsWith('/batch/update')).every((c) => c.body.inputs.length <= 100));
  const writes1 = m.state.updates.length;
  const r2 = run(ARMED, m);
  check('Rerun same day: zero new enrollments, zero list changes', !r2.error && m.state.enrollments.length === 3 && m.state.lists['71000001'].size === 2);
  check('Rerun: routed contacts now COOLING from their recycle date (clock restarted), no re-routing', dec(r2, 51000001).decision === 'COOLING' && dec(r2, 51000001).clockFrom === 'lastRecycled');
  const rewritten = m.state.updates.slice(writes1).map((u) => u.id);
  check('Rerun: unchanged suppressed / cooling contacts are not rewritten', !rewritten.includes('51000005') && !rewritten.includes('51000011'), rewritten.join(','));
  check('Report counts only contacts routed in THIS run (run 1: 3 outbound / 2 nurture, rerun: 0 / 0)', reportOf(r1).routedOutbound === 3 && reportOf(r1).routedNurture === 2 && reportOf(r2).routedOutbound === 0 && reportOf(r2).routedNurture === 0);
  check('Manual DO_NOT_RECYCLE flag is never overwritten (stays DO_NOT_RECYCLE after two runs)', m.state.contacts.get('51000022').recycle_status === 'DO_NOT_RECYCLE' && dec(r2, 51000022).reason === 'DO_NOT_RECYCLE');
  check('Routed contacts keep RECYCLED_* status while cooling again (not flipped to COOLING)', m.state.contacts.get('51000001').recycle_status === 'RECYCLED_OUTBOUND' && m.state.contacts.get('51000002').recycle_status === 'RECYCLED_NURTURE');
  check('Rerun: risky-email HOLD is not re-verified within the interval (no daily credit burn); enrichment failure IS retried', dec(r2, 51000021).decision === 'SKIP' && dec(r2, 51000017).reason === 'ENRICHMENT_FAILED');
  check('Rerun writes only the retried contact (enrichment failure), nothing else', JSON.stringify(m.state.updates.slice(writes1).map((u) => u.id)) === JSON.stringify(['51000017']), m.state.updates.slice(writes1).map((u) => u.id).join(','));
  const ms2 = makeMocks();
  const opt = run({ ...ARMED, UPDATE_JOB_TITLE: 'true', SET_LEAD_STATUS_ON_ROUTE: 'OPEN' }, ms2);
  check('UPDATE_JOB_TITLE=true + SET_LEAD_STATUS_ON_ROUTE=OPEN: title refreshed, routed leads reopened', !opt.error && ms2.state.contacts.get('51000023').jobtitle === 'VP Growth' && ms2.state.contacts.get('51000014').hs_lead_status === 'OPEN' && ms2.state.contacts.get('51000020').hs_lead_status === 'UNQUALIFIED');
  const fe = makeMocks({ failEnroll: (id) => id === '51000014' });
  const fr = run(ARMED, fe);
  check('Enrollment failure -> PARTIAL, contact HOLD (ENROLLMENT_FAILED), not counted as recycled', reportOf(fr).status === 'PARTIAL' && outcome(fr, 51000014).status === 'HOLD' && outcome(fr, 51000014).reason === 'ENROLLMENT_FAILED' && fe.state.contacts.get('51000014').recycle_count === undefined);
  const fr2 = run({ ...ARMED, NOW_OVERRIDE: '2026-11-17T12:00:00.000Z' }, makeMocksFrom(fe));
  check('HOLD is retried on the next run (not blocked by the re-evaluation interval) and enrolls', outcome(fr2, 51000014) && outcome(fr2, 51000014).status === 'RECYCLED_OUTBOUND');
  const seqOff = makeMocks();
  const so = run({ ...ARMED, SEQUENCE_ENROLLMENT_ENABLED: 'false' }, seqOff);
  check('SEQUENCE_ENROLLMENT_ENABLED=false: no enrollment calls; outbound contacts stamped ELIGIBLE_OUTBOUND', seqOff.state.enrollments.length === 0 && !seqOff.state.calls.some((c) => c.path.includes('/sequences/')) && outcome(so, 51000001).status === 'ELIGIBLE_OUTBOUND');
  const nurOff = makeMocks();
  const no = run({ ...ARMED, NURTURE_ROUTING_ENABLED: 'false' }, nurOff);
  check('NURTURE_ROUTING_ENABLED=false: no list adds; nurture contacts stamped ELIGIBLE_NURTURE', !nurOff.state.lists['71000001'] && outcome(no, 51000002).status === 'ELIGIBLE_NURTURE');
  const um = makeMocks({ failUpdate: true });
  const ur = run(ARMED, um);
  check('Contact update outage -> PARTIAL with write errors reported', reportOf(ur).status === 'PARTIAL' && reportOf(ur).writeResults.some((w) => w.kind === 'update' && !w.ok));
  fs.writeFileSync(path.join(OUT_DIR, 'armed-run-report.json'), JSON.stringify(reportOf(r1), null, 2) + '\n');

  // --------------------------------------------- 8. fail closed
  section('8. Fail-closed paths');
  const f1 = run(ARMED, makeMocks({ failSearch: true }));
  check('Deal search failure stops the run before any enrichment or write', f1.error && f1.mocks.state.enrichCalls.length === 0 && f1.mocks.state.updates.length === 0);
  const f2 = run(ARMED, makeMocks({ fakeTotal: 12000 }));
  check('10,000+ search matches -> run refused (cannot page further)', f2.error && /10,000/.test(f2.error.message));
  const f3 = makeMocks({ failEnrich: true });
  const f3r = run(ARMED, f3);
  check('Enrichment outage -> every cooled-off contact HOLD (ENRICHMENT_FAILED); no enrollments', !f3r.error && routeOf(f3r).decisions.filter((d) => d.reason === 'ENRICHMENT_FAILED').length === 12 && f3.state.enrollments.length === 0);
  const f4 = run({ ...ARMED, COOLING_OFF_DAYS: '-5' }, makeMocks());
  check('Config error with everything armed -> dry-run only, zero writes', reportOf(f4).status !== 'COMPLETED' && f4.mocks.state.updates.length === 0 && f4.mocks.state.enrollments.length === 0);
  const empty = run(ARMED, makeMocks({ contacts: [], deals: [], associations: { dealContacts: {}, contactDeals: {} } }));
  check('Empty population -> NOTHING_TO_EVALUATE, no writes', !empty.error && reportOf(empty).status === 'NOTHING_TO_EVALUATE', empty.error && empty.error.message);
  const sch = runWorkflow({ trigger: 'schedule', env: { NOW_OVERRIDE: NOW }, mocks: makeMocks(), staticData: {} });
  check('Daily schedule trigger runs the same pipeline (sandbox)', !sch.error && reportOf(sch).status === 'SANDBOX_DRY_RUN');

  console.log(`\n${failed === 0 ? '✅' : '❌'} ${passed} passed, ${failed} failed`);
  const d = routeOf(sb).report.decisions;
  console.log(`Sandbox: ${d.OUTBOUND} outbound, ${d.NURTURE} nurture, ${d.SUPPRESS} suppressed, ${d.COOLING} cooling, ${d.HOLD} held, ${d.SKIP} skipped`);
  console.log('Output written to: sim-output/ (git-ignored)');
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ` - ${f}`).join('\n')); process.exit(1); }
})();

// A new mock that continues from another mock's HubSpot state (same records, enrollments, lists).
function makeMocksFrom(prev) {
  const m = makeMocks();
  for (const [k, v] of prev.state.contacts) m.state.contacts.set(k, clone(v));
  for (const [k, v] of prev.state.active) m.state.active.set(k, clone(v));
  for (const [k, v] of Object.entries(prev.state.lists)) m.state.lists[k] = new Set(v);
  return m;
}
