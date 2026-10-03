const API = '';
const ORG = 'cadent-demo';
const state = {
  view: 'overview', snapshot: null, disruptions: [], network: [], assessment: null, materials: null,
  selectedSupplier: null, riskProfile: null, role: 'VIEWER', keys: {}, busy: false,
  currentAction: null, ariba: null, notice: '', activeDisruptionId: null,
};
const page = document.querySelector('#page');
const dialog = document.querySelector('#dialog');
const overlay = document.querySelector('#overlay');
const esc = (value = '') => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initials = (name = '') => name.split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase();

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (path !== '/api/v1/demo/supply-chain') headers['x-organization-id'] = ORG;
  if (options.key) headers['x-demo-role-key'] = options.key;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(API + path, { method: options.method || 'GET', headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(data?.message || data?.error?.message || `Request failed (${response.status})`);
  return data;
}
const money = (amount, currency = 'GBP') => new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(amount || 0);
const date = (value) => value ? new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(value)) : 'Not provided';
const categoryName = (s) => s.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (x) => x.toUpperCase());
const currentContext = () => state.disruptions.find((x) => x.disruption?.id === selectedDisruptionId()) || state.disruptions[0];
const selectedDisruptionId = () => state.activeDisruptionId || state.snapshot?.suggestedDemoDisruptionId || state.snapshot?.disruptions?.[0]?.id;

function setView(view) {
  state.view = view;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelector('#crumb').textContent = ({ overview: 'Overview', disruptions: 'Disruptions', materials: 'Materials', network: 'Supplier network', risk: 'Risk coverage' })[view] || 'Overview';
  render();
}
function notify(message, error = false) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' error' : ''}`;
  toast.textContent = message;
  document.querySelector('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 3400);
}
function openDialog(content) {
  dialog.innerHTML = content;
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
  dialog.querySelector('input,select,button')?.focus();
}
function closeDialog() {
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
}
function settingsDialog() {
  openDialog(`<button class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><div class="eyebrow">Local demo access</div><h2 id="dialog-title">Connect a demo role</h2><p>Enter a role key configured in the Core API terminal. It stays in this browser session only and is never saved to the URL or local storage.</p><label for="role-select">Role key type</label><select id="role-select"><option value="VIEWER">Viewer · assess and review</option><option value="OPERATOR">Operator · propose recovery</option><option value="MANAGER">Manager · approve or reject</option><option value="ADMIN">Admin · approve or reject</option></select><label for="role-key">Demo role key</label><input id="role-key" type="password" autocomplete="off" placeholder="Paste the key configured in the server terminal" value="${esc(state.keys[state.role] || '')}"/><div class="notice" style="margin-top:12px">If you have not configured server keys, stop the API and set <code>DEMO_VIEWER_KEY</code>, <code>DEMO_OPERATOR_KEY</code>, and <code>DEMO_MANAGER_KEY</code> before starting it again.</div><div class="dialog-actions"><button class="button" data-action="close-dialog">Cancel</button><button class="button primary" data-action="save-key">Use key for this session</button></div>`);
  document.querySelector('#role-select').value = state.role;
}
function aboutDialog() {
  openDialog(`<button class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><div class="eyebrow">About this workspace</div><h2 id="dialog-title">Supplier data and operational exposure</h2><p>Manage material stock, demand and lead-time records. The API persists the materials register locally and recalculates cover and shortage figures from saved values.</p><div class="notice"><strong>Sample supplier scenario.</strong> Seeded suppliers, depots, disruption and risk feeds are illustrative. Entered materials are stored on this machine in the Core API data folder. This is not connected to Cadent, SAP Ariba, ERP or other live company systems.</div><p style="margin-bottom:0">Recovery decisions remain review records only; no purchase order or stock transfer is executed.</p><div class="dialog-actions"><button class="button primary" data-action="close-dialog">Got it</button></div>`);
}
function heading(title, description, action = '') {
  return `<div class="page-heading"><div><div class="eyebrow">Supplier intelligence</div><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${action}</div></div>`;
}
function chip(label, type = 'unknown') { return `<span class="status-chip ${type}">${esc(label)}</span>`; }
function metric(label, value, foot, icon, tone = '') {
  return `<article class="metric-card"><div class="metric-top"><span>${label}</span><span class="metric-icon">${icon}</span></div><div class="metric-value ${tone}">${value}</div><div class="metric-foot">${foot}</div></article>`;
}
function activeImpact() { return state.assessment?.impacts?.[0] || currentContext()?.impacts?.[0]; }
function activeOptions() { return state.assessment?.options || currentContext()?.options || []; }
function riskSignals() { return currentContext()?.riskSignals || []; }

function renderOverview() {
  if (!state.snapshot) return renderLoading();
  const context = currentContext();
  const disruption = context?.disruption || state.snapshot.disruptions?.[0];
  const impact = activeImpact();
  const days = impact?.daysOfCover ?? 0;
  const delay = disruption?.delayDays ?? 0;
  const level = state.assessment?.riskLevel || (impact?.serviceCriticality === 'CRITICAL' ? 'CRITICAL' : 'HIGH');
  const supplierCount = state.network.length || state.snapshot.suppliers?.length || 0;
  const recommendation = state.assessment?.recommendation;
  const recommended = activeOptions().find((o) => o.id === recommendation?.optionId);
  const navAction = `<button class="button" data-view="network">View supplier network <span>↗</span></button><button class="button primary" data-action="assess" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Analyzing…' : '✦  Analyze disruption'}</button>`;
  const categories = ['OPERATIONAL', 'BUSINESS_CONTINUITY', 'FINANCIAL', 'CYBER', 'ESG', 'COMPLIANCE', 'GEOPOLITICAL', 'REPUTATIONAL'];
  const coverage = categories.map((category) => {
    const signal = riskSignals().find((s) => s.category === category);
    const signalLevel = signal?.level || 'UNKNOWN';
    return `<div class="coverage-item"><span>${categoryName(category)}</span><strong><i class="dot ${signalLevel === 'HIGH' || signalLevel === 'CRITICAL' ? 'high' : 'unknown'}"></i>${signalLevel === 'UNKNOWN' ? 'Unknown' : categoryName(signalLevel)}</strong></div>`;
  }).join('');
  page.innerHTML = `${heading('See the risk before it reaches the field', 'Connect supplier disruption to stock cover, service exposure, and the next best response.', navAction)}
    <div class="metrics-grid">${metric('Open disruptions', state.disruptions.length || '—', 'Current supplier events', '◉')}${metric('Materials tracked', state.materials?.statistics?.materialCount ?? '—', 'Saved in materials register', '▤')}${metric('Materials below cover', state.materials?.statistics?.atRiskCount ?? '—', 'Cover compared with lead time', '⌖')}${metric('Stock cover · active event', `${days} days`, `<span class="warning-text">${delay} day supplier delay</span> reported`, '◷')}</div>
    <div class="dashboard-grid"><section class="card impact-card"><div class="card-head"><div><h2 class="card-title">Disruption impact window</h2><div class="card-subtitle">Inventory cover compared with reported supplier delay</div></div>${chip(level === 'CRITICAL' ? 'CRITICAL EXPOSURE' : 'HIGH EXPOSURE', level === 'CRITICAL' ? 'critical' : 'high')}</div>
      <div class="impact-summary"><strong>${days} days</strong><span>of cover at Manchester depot</span><span>·</span><span>${(impact?.shortageUnits || 0).toLocaleString('en-GB')} units exposed</span></div>
      <div class="timeline"><div class="timeline-track"><div class="timeline-stock"></div><div class="timeline-gap"></div></div><i class="timeline-point"></i><i class="timeline-arrival"></i><div class="timeline-labels"><span>Today</span><span class="stockout">Day ${days} · projected stockout</span><span>Day ${delay} · supplier ETA</span></div></div>
      <div class="timeline-caption"><span><b>4 days</b> current cover</span><span class="risk"><b>6-day</b> uncovered window</span><span><b>${(impact?.shortageUnits || 0).toLocaleString('en-GB')}</b> units at risk</span></div>
      ${state.assessment ? `<div class="analysis-result"><span class="result-icon">✦</span><span><b>${recommendation?.optionId ? `Suggested: ${esc(recommended?.title || recommendation.optionId)}` : 'No feasible option selected'}</b><small>${esc(recommendation?.rationale || state.assessment.summary)} · ${state.assessment.status === 'DEGRADED' ? 'deterministic fallback' : 'AI assisted'} · ${Math.round((recommendation?.confidence || 0) * 100)}% confidence</small></span></div>` : '<div class="analysis-hint"><span>✦</span> Run an assessment to compare recovery paths against available evidence.</div>'}</section>
      <section class="card disruption-card"><div class="disruption-banner"><div class="disruption-id">${esc(disruption?.id || 'NO DISRUPTION')}</div><h3>${esc(context?.disruption?.supplierName || 'Supplier delay reported')}</h3><p>${esc(context?.disruption?.sourceMessage || 'Open the disruption list to review reported events.')}</p><div style="margin-top:9px">${chip('OPEN · NEEDS REVIEW', 'high')}</div></div><div class="disruption-detail"><div class="detail-row"><span>Material</span><strong>${esc(context?.disruption?.itemName || '—')}</strong></div><div class="detail-row"><span>Supplier tier</span><strong>Tier 2 → Tier 1</strong></div><div class="detail-row"><span>Reported delay</span><strong>${delay} days</strong></div><div class="detail-row"><span>First affected area</span><strong>North West · synthetic</strong></div><div class="detail-row"><span>Reported</span><strong>${date(disruption?.reportedAt)}</strong></div></div></section></div>
    <section class="card coverage-card"><div class="card-head"><div><h2 class="card-title">Risk coverage</h2><div class="card-subtitle">Current evidence across supplier risk categories</div></div><button class="text-link" data-view="risk">View all categories →</button></div><div class="coverage-list">${coverage}</div><div class="coverage-foot"><span><b>Unknown means no current feed</b> · missing evidence is not a low-risk rating.</span><span>${state.snapshot.ariba?.connected ? 'Connected' : 'Ariba adapter disconnected'}</span></div></section>`;
}

function optionCard(option, recommendedId) {
  const recommended = option.id === recommendedId;
  return `<article class="option-card ${recommended ? 'recommended' : ''} ${!option.feasible ? 'blocked' : ''}"><div class="option-top"><i class="option-radio"></i><div class="option-name"><h3>${esc(option.title)}</h3><p>${esc(option.description)}</p></div><span class="option-tag ${!option.feasible ? 'blocked' : ''}">${recommended ? 'AI suggested' : !option.feasible ? 'Not feasible' : option.requiresApproval ? 'Approval needed' : 'Available'}</span></div><div class="option-metrics"><div class="option-metric"><span>EST. COST</span><b>${money(option.estimatedCost, option.currency)}</b></div><div class="option-metric"><span>ARRIVES IN</span><b>${option.arrivesInDays} days</b></div><div class="option-metric"><span>QUANTITY</span><b>${option.quantityUnits.toLocaleString('en-GB')} units</b></div><div class="option-metric"><span>SHORTAGE LEFT</span><b>${option.residualShortageUnits.toLocaleString('en-GB')} units</b></div></div><div class="option-note ${!option.feasible ? 'blocked' : ''}">${(option.constraints || []).map(esc).join(' · ') || 'No additional constraints stated.'}</div><div class="option-actions">${option.feasible ? `<button class="button small ${recommended ? 'primary' : ''}" data-action="propose" data-option="${esc(option.id)}">Review this option →</button>` : chip('Evidence required before sourcing', 'unknown')}</div></article>`;
}
function renderDisruptions() {
  if (!state.snapshot) return renderLoading();
  const context = currentContext();
  const assessment = state.assessment;
  const options = assessment?.options || context?.options || [];
  const recId = assessment?.recommendation?.optionId;
  const imp = activeImpact();
  const evidence = assessment?.evidence || context?.evidence || [];
  page.innerHTML = `${heading('Disruptions', 'Trace a supplier delay from upstream signal to exposed stock and a reviewed response.', `<button class="button" data-action="about">ⓘ Demo data notes</button><button class="button primary" data-action="assess" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Assessing…' : '✦ Assess impact'}</button>`)}
    <div class="section-grid"><div class="card"><div class="card-head"><div><h2 class="card-title">${esc(context?.disruption?.supplierName || 'No disruption loaded')}</h2><div class="card-subtitle">${esc(context?.disruption?.id || '')} · ${esc(context?.disruption?.itemName || '')}</div></div>${chip(`${context?.disruption?.delayDays || 0}-DAY DELAY`, 'high')}</div><div class="detail-row"><span>Supplier tier path</span><strong>${(context?.supplierNetwork || []).slice().sort((a,b)=>b.tier-a.tier).map(s=>`T${s.tier} ${esc(s.name.split(' (')[0])}`).join(' → ')}</strong></div><div class="detail-row"><span>Facility / service area</span><strong>${esc(imp?.facilityName || '—')} · ${esc(imp?.serviceArea || '—')}</strong></div><div class="detail-row"><span>Available / daily demand</span><strong>${(imp?.availableUnits || 0).toLocaleString('en-GB')} / ${(imp?.dailyDemand || 0).toLocaleString('en-GB')} units</strong></div><div class="detail-row"><span>Cover / uncovered period</span><strong>${imp?.daysOfCover || 0} days / ${imp?.uncoveredDays || 0} days</strong></div><div class="detail-row"><span>Projected shortfall</span><strong class="warning-text">${(imp?.shortageUnits || 0).toLocaleString('en-GB')} units</strong></div>${assessment ? `<div class="analysis-result"><span class="result-icon">✦</span><span><b>Assessment ${assessment.status === 'DEGRADED' ? 'used the deterministic fallback' : 'completed'}</b><small>${esc(assessment.summary)}</small></span></div>` : `<div class="analysis-hint"><span>✦</span> Assessment not run yet. Analyze to get an evidence-linked recovery suggestion.</div>`}</div>
      <aside class="card"><div class="card-head"><div><h2 class="card-title">Decision context</h2><div class="card-subtitle">What this scenario does and does not know</div></div></div><div class="notice"><strong>Illustrative scenario.</strong> Verify inventory, demand, supplier ETA and cost in source systems before taking action.</div><div style="height:12px"></div>${(context?.dataWarnings || []).map(w=>`<div class="evidence-row"><i class="evidence-mark">i</i><span><b>Data limitation</b><small>${esc(w)}</small></span></div>`).join('')}</aside></div>
    <div class="section-grid" style="margin-top:14px"><section class="card"><div class="card-head"><div><h2 class="card-title">Recovery options</h2><div class="card-subtitle">Core API feasibility and constraints · AI recommendation is advisory</div></div>${assessment?.model ? chip(assessment.model.provider === 'deterministic' ? 'FALLBACK' : 'AI REVIEW', assessment.model.provider === 'deterministic' ? 'unknown' : 'good') : ''}</div><div class="options-list">${options.length ? options.map(o=>optionCard(o,recId)).join('') : '<div class="empty-state">Run an impact assessment to load recovery options.</div>'}</div></section><aside class="card"><div class="card-head"><div><h2 class="card-title">Evidence trail</h2><div class="card-subtitle">Source records used in the scenario</div></div></div><div class="evidence-list">${evidence.length ? evidence.map(e=>`<div class="evidence-row"><i class="evidence-mark">✓</i><span><b>${esc(e.field)} · ${esc(e.source)}</b><small>${esc(String(e.value ?? 'Unknown'))} · ${esc(e.freshness || 'CURRENT')} · ${date(e.observedAt)}</small></span></div>`).join('') : '<div class="empty-state">Evidence appears after the disruption context loads.</div>'}</div></aside></div>`;
}

function drawConnections() {
  const wrap = document.querySelector('.network-wrap');
  const svg = document.querySelector('.network-svg');
  if (!wrap || !svg) return;
  const box = wrap.getBoundingClientRect();
  svg.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  const nodes = [...wrap.querySelectorAll('.supplier-node')];
  const findNode = (id) => nodes.find((n) => n.dataset.supplier === id);
  const paths = [];
  for (const supplier of state.network) {
    for (const parentId of supplier.parentSupplierIds || []) {
      const from = findNode(parentId), to = findNode(supplier.id);
      if (!from || !to) continue;
      const a = from.getBoundingClientRect(), b = to.getBoundingClientRect();
      const x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top;
      const x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top;
      const curve = Math.max(24, (x2 - x1) * .48);
      paths.push(`<path d="M ${x1} ${y1} C ${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}"/>`);
    }
  }
  svg.innerHTML = paths.join('');
}
function renderNetwork() {
  if (!state.network.length) return renderLoading();
  const tiers = [3, 2, 1];
  const columns = tiers.map((tier) => `<section class="tier-column"><h3>Tier ${tier} ${tier === 3 ? '· upstream' : tier === 1 ? '· direct' : ''}</h3>${state.network.filter(s=>s.tier===tier).map(s=>`<button class="supplier-node ${state.selectedSupplier===s.id?'selected':''}" data-action="supplier" data-supplier="${esc(s.id)}"><i class="node-status ${s.status==='ACTIVE'?'active':''}"></i><span class="node-name">${esc(s.name.replace(' (synthetic)',''))}</span><span class="node-meta">${esc(s.id)} · ${esc(s.criticality)} criticality</span></button>`).join('') || '<div class="empty-state">No suppliers in this tier</div>'}</section>`).join('');
  const selected = state.network.find(s=>s.id===state.selectedSupplier) || state.network[0];
  const profile = state.riskProfile;
  const signals = profile?.categories || [];
  page.innerHTML = `${heading('Supplier network', 'Follow upstream dependencies that can shape downstream service exposure.', `<span class="badge">${state.network.length} synthetic suppliers</span>`)}<section class="card"><div class="network-layout"><div class="network-wrap"><svg class="network-svg" aria-hidden="true"></svg><div class="network-columns">${columns}</div></div><aside class="supplier-detail"><div class="eyebrow">Selected supplier</div><h3>${esc(selected.name)}</h3><p>${esc(selected.id)}<br/>Tier ${selected.tier} · ${esc(selected.status)}<br/>${esc(selected.criticality)} criticality</p><p>Upstream links<br/><b>${(selected.parentSupplierIds || []).map(id=>esc(state.network.find(s=>s.id===id)?.name || id)).join('<br/>') || 'No upstream dependency listed'}</b></p><button class="button small" data-action="open-risk" data-supplier="${esc(selected.id)}">View risk profile →</button></aside></div><div class="coverage-foot"><span>Lines show supplied tier dependencies; actual sourcing relationships must be validated.</span><span>All suppliers synthetic</span></div></section><section class="card coverage-card"><div class="card-head"><div><h2 class="card-title">${esc(selected.name)} · risk profile</h2><div class="card-subtitle">${profile ? 'Source-backed categories for selected supplier' : 'Select a supplier to retrieve its category evidence'}</div></div></div>${signals.length ? `<div class="risk-grid">${signals.map(s=>`<div class="risk-tile"><span class="risk-label">${categoryName(s.category)}</span><strong>${chip(categoryName(s.level),s.level==='HIGH'||s.level==='CRITICAL'?'high':s.level==='LOW'?'good':'unknown')}</strong><p>${esc(s.summary)}</p></div>`).join('')}</div>` : '<div class="empty-state">Risk signals are loaded when you select a supplier.</div>'}</section>`;
  requestAnimationFrame(drawConnections);
}
function renderRisk() {
  if (!state.snapshot) return renderLoading();
  const signals = state.riskProfile?.categories || riskSignals();
  const evidence = state.riskProfile?.evidence || currentContext()?.evidence || [];
  const categories = ['FINANCIAL','OPERATIONAL','BUSINESS_CONTINUITY','CYBER','ESG','COMPLIANCE','GEOPOLITICAL','REPUTATIONAL'];
  page.innerHTML = `${heading('Risk coverage', 'Separate observed risk signals from areas where the demo has no evidence.', `<button class="button" data-action="supplier-risk">Refresh supplier risk</button>`)}<div class="notice" style="margin-bottom:13px"><strong>Important:</strong> “Unknown” means a current evidence feed is unavailable. It does not mean low risk. This scenario is synthetic and has no external risk feeds.</div><section class="card"><div class="card-head"><div><h2 class="card-title">${esc(state.riskProfile?.supplier?.name || currentContext()?.disruption?.supplierName || 'Supplier risk categories')}</h2><div class="card-subtitle">Eight categories · evidence freshness shown per signal</div></div></div><div class="risk-grid">${categories.map(cat=>{const s=signals.find(x=>x.category===cat);const level=s?.level||'UNKNOWN';return `<div class="risk-tile"><span class="risk-label">${categoryName(cat)}</span><strong>${chip(categoryName(level),level==='HIGH'||level==='CRITICAL'?'high':level==='LOW'?'good':'unknown')}</strong><p>${esc(s?.summary||'No current feed in this synthetic demo.')}</p><p>Source: ${esc(s?.source||'NO_DEMO_FEED')}<br/>Observed: ${date(s?.observedAt)}</p></div>`;}).join('')}</div></section><section class="card coverage-card"><div class="card-head"><div><h2 class="card-title">Evidence inventory</h2><div class="card-subtitle">Known records supporting the current supplier context</div></div></div><div class="evidence-list">${evidence.map(e=>`<div class="evidence-row"><i class="evidence-mark">✓</i><span><b>${esc(e.source)} · ${esc(e.field)}</b><small>${esc(String(e.value??'Unknown'))} · ${esc(e.freshness)} · ${date(e.observedAt)}</small></span></div>`).join('')||'<div class="empty-state">No evidence is available.</div>'}</div></section>`;
}
function materialDialog(id = '') {
  const m = state.materials?.materials?.find(x=>x.id===id); const ss=state.snapshot?.suppliers||[];
  openDialog(`<button class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><div class="eyebrow">Materials register · saved on this API</div><h2 id="dialog-title">${m?'Update material':'Add a material'}</h2><p>Stock cover and projected shortage recalculate from the values you save.</p><div class="form-grid"><label>Material name<input id="mat-name" maxlength="120" value="${esc(m?.name||'')}"></label><label>Code<input id="mat-code" maxlength="32" value="${esc(m?.code||'')}"></label><label>Supplier<select id="mat-supplier">${ss.map(s=>`<option value="${esc(s.id)}" ${m?.supplierId===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><label>Depot<select id="mat-facility"><option value="DEPOT-MAN" ${m?.facilityId==='DEPOT-MAN'?'selected':''}>Manchester</option><option value="DEPOT-BIR" ${m?.facilityId==='DEPOT-BIR'?'selected':''}>Birmingham</option></select></label><label>Available units<input id="mat-stock" type="number" min="0" step="1" value="${m?.availableUnits??''}"></label><label>Daily demand<input id="mat-demand" type="number" min="0.01" step="0.01" value="${m?.dailyDemand??''}"></label><label>Lead time (days)<input id="mat-lead" type="number" min="0.01" step="0.01" value="${m?.leadTimeDays??''}"></label><label>Transferable units<input id="mat-transfer" type="number" min="0" step="1" value="${m?.transferableUnits??0}"></label><label>Unit cost (GBP)<input id="mat-cost" type="number" min="0" step="0.01" value="${m?.unitCost??''}"></label><label>Criticality<select id="mat-criticality">${['LOW','MEDIUM','HIGH','CRITICAL'].map(x=>`<option ${m?.criticality===x?'selected':''}>${x}</option>`).join('')}</select></label></div><div class="dialog-actions"><button class="button" data-action="close-dialog">Cancel</button><button class="button primary" data-action="save-material" data-id="${esc(id)}">Save material</button></div>`);
}
function renderMaterials() {
  if (!state.materials) return renderLoading(); const st=state.materials.statistics;
  const rows=state.materials.materials.map(m=>`<tr><td><b>${esc(m.name)}</b><small>${esc(m.code)} · ${esc(state.network.find(s=>s.id===m.supplierId)?.name||m.supplierId)}</small></td><td>${m.facilityId==='DEPOT-BIR'?'Birmingham':'Manchester'}</td><td>${Number(m.availableUnits).toLocaleString('en-GB')}<small>${Number(m.dailyDemand).toLocaleString('en-GB')} used/day</small></td><td>${m.daysOfCover} days<small>${m.leadTimeDays} day lead</small></td><td>${Number(m.shortageUnits).toLocaleString('en-GB')} units</td><td>${chip(m.daysOfCover<m.leadTimeDays?'At risk':'Covered',m.daysOfCover<m.leadTimeDays?'high':'good')}</td><td><button class="button small" data-action="report-disruption" data-id="${esc(m.id)}">Report delay</button><button class="button small" data-action="edit-material" data-id="${esc(m.id)}">Edit</button> ${m.id!=='MAT-DN300-REG'?`<button class="button small" data-action="delete-material" data-id="${esc(m.id)}">Remove</button>`:''}</td></tr>`).join('');
  page.innerHTML=`${heading('Materials register','Maintain stock, demand and supplier lead-time inputs used by the live calculations.','<button class="button primary" data-action="add-material">＋ Add material</button>')}<div class="metrics-grid">${metric('Materials tracked',st.materialCount,'Saved records','▤')}${metric('Below lead-time cover',st.atRiskCount,'Potential stockout before replenishment','⚑')}${metric('Available units',Number(st.availableUnits).toLocaleString('en-GB'),'All registered materials','□')}${metric('Estimated stock value',money(st.estimatedStockValue),'Available stock × unit cost','£')}</div><section class="card material-table-card"><div class="card-head"><div><h2 class="card-title">Current material data</h2><div class="card-subtitle">Recalculated on save · shared clients refresh every five seconds</div></div><button class="button small" data-action="refresh-materials">Refresh</button></div><div class="table-scroll"><table class="material-table"><thead><tr><th>Material / supplier</th><th>Depot</th><th>Stock / daily use</th><th>Cover / lead</th><th>Shortage</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div><div class="coverage-foot"><span>Cover = available ÷ daily demand. Shortage = max(0, lead time × daily demand − available stock).</span><span>Updated ${date(state.materials.updatedAt)}</span></div></section>`;
}
function disruptionDialog(materialId) {
  const m=state.materials?.materials?.find(x=>x.id===materialId); if(!m)return;
  openDialog(`<button class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><div class="eyebrow">Supplier event</div><h2 id="dialog-title">Report a material delay</h2><p>${esc(m.name)} · ${esc(m.code)} · impacts will use the saved inventory and demand figures.</p><label>Expected delay (days)<input id="event-delay" type="number" min="1" max="90" value="10"></label><label>Supplier notice / source details<input id="event-message" maxlength="1000" value="Supplier reported a delay affecting ${esc(m.name)}."></label><div class="dialog-actions"><button class="button" data-action="close-dialog">Cancel</button><button class="button primary" data-action="submit-disruption" data-id="${esc(m.id)}">Create disruption</button></div>`);
}
function renderLoading() {
  page.innerHTML = `${heading('Loading supplier intelligence', 'Connecting to the local demonstration API…')}<section class="card"><div class="loading">Loading the synthetic supplier network and disruption context.</div></section>`;
}
function renderError(message) {
  page.innerHTML = `${heading('Dashboard unavailable', 'The local API did not return the demo data.', '<button class="button primary" data-action="reload">Retry connection</button>')}<section class="card"><div class="notice"><strong>Could not connect.</strong> ${esc(message)}<br/>Start the Core API, then reload this page.</div></section>`;
}
function render() {
  if (!state.snapshot) return renderLoading();
  if (state.view === 'disruptions') return renderDisruptions();
  if (state.view === 'network') return renderNetwork();
  if (state.view === 'risk') return renderRisk();
  if (state.view === 'materials') return renderMaterials();
  renderOverview();
}
async function loadData() {
  try {
    const [snapshot, disruptionList, network, ariba, materials] = await Promise.all([
      api('/api/v1/demo/supply-chain'),
      api('/api/v1/disruptions'),
      api('/api/v1/suppliers/network'),
      api('/api/v1/integrations/ariba/status'),
      api('/api/v1/materials'),
    ]);
    state.snapshot = snapshot;
    state.disruptions = disruptionList.data || [];
    state.network = network.data || snapshot.suppliers || [];
    state.ariba = ariba;
    state.materials = materials;
    state.selectedSupplier = state.network.find(s=>s.tier===2)?.id || state.network[0]?.id;
    render();
  } catch (error) { renderError(error.message); }
}
async function loadSupplierRisk(id) {
  if (!id) return;
  try {
    state.selectedSupplier = id;
    state.riskProfile = await api(`/api/v1/suppliers/${encodeURIComponent(id)}/risk`);
    render();
  } catch (error) { notify(error.message, true); }
}
async function runAssessment() {
  const key = state.keys[state.role];
  if (!key) { settingsDialog(); notify('Add a configured demo role key to assess this disruption.'); return; }
  const id = selectedDisruptionId();
  state.busy = true; render();
  try {
    state.assessment = await api(`/api/v1/disruptions/${encodeURIComponent(id)}/assess`, { method: 'POST', key, body: {} });
    notify(state.assessment.status === 'DEGRADED' ? 'Assessment completed with deterministic fallback.' : 'Disruption assessment completed.');
  } catch (error) { notify(error.message, true); }
  finally { state.busy = false; render(); }
}
async function propose(optionId) {
  const role = state.role;
  const key = state.keys[role];
  if (!key) { settingsDialog(); notify('Add an operator or manager demo key to review a recovery option.'); return; }
  if (role === 'VIEWER') { notify('Switch to an Operator or Manager demo key to propose a controlled action.', true); settingsDialog(); return; }
  try {
    const result = await api(`/api/v1/disruptions/${encodeURIComponent(selectedDisruptionId())}/decide`, { method: 'POST', key, body: { organizationId: ORG, optionId } });
    state.currentAction = result;
    if (result.decision === 'APPROVAL') approvalDialog(result);
    else openDialog(`<button class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><div class="eyebrow">Simulation decision</div><h2 id="dialog-title">${esc(result.decision)}</h2><p>${esc(result.reason)}</p><div class="notice">${esc(result.nextStep)} This is simulation only; no real action was executed.</div><div class="dialog-actions"><button class="button primary" data-action="close-dialog">Close</button></div>`);
  } catch (error) { notify(error.message, true); }
}
function approvalDialog(action) {
  const needsManagerKey = !state.keys.MANAGER && !state.keys.ADMIN;
  openDialog(`<button class="dialog-close" data-action="close-dialog" aria-label="Close">×</button><div class="eyebrow">Human review · ${esc(action.id)}</div><h2 id="dialog-title">Manager approval required</h2><p>${esc(action.reason)}</p><div class="notice"><strong>Simulation only.</strong> Approval records a demo audit event; it does not move stock or create a purchase order.</div>${needsManagerKey ? '<div class="option-note" style="margin:12px 0 0">Configure a Manager or Admin key in demo access settings before recording the review.</div><div class="dialog-actions"><button class="button" data-action="settings">Configure reviewer key</button></div>' : ''}<div class="dialog-actions"><button class="button" data-action="reject" ${needsManagerKey?'disabled':''}>Reject</button><button class="button primary" data-action="approve" ${needsManagerKey?'disabled':''}>Approve in simulation</button></div>`);
}
async function approveAction(approved) {
  const action = state.currentAction;
  const role = state.keys.MANAGER ? 'MANAGER' : 'ADMIN';
  const key = state.keys[role];
  if (!action || !key) { closeDialog(); settingsDialog(); notify('Configure a Manager or Admin demo key first.', true); return; }
  try {
    const result = await api(`/api/v1/recovery-actions/${encodeURIComponent(action.id)}/approve`, { method: 'POST', key, body: { approved } });
    closeDialog();
    notify(approved ? 'Approved in simulation only.' : 'Recovery option rejected.');
    state.currentAction = result;
  } catch (error) { notify(error.message, true); }
}

document.addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.view) return setView(button.dataset.view);
  const action = button.dataset.action;
  if (action === 'close-dialog') return closeDialog();
  if (action === 'settings') return settingsDialog();
  if (action === 'about') return aboutDialog();
  if (action === 'reload') return loadData();
  if (action === 'add-material') return materialDialog();
  if (action === 'edit-material') return materialDialog(button.dataset.id);
  if (action === 'save-material') {
    const key=state.keys[state.role];
    if (!key || !['ADMIN','MANAGER','OPERATOR'].includes(state.role)) { settingsDialog(); return notify('Connect an Operator, Manager or Admin key to save materials.',true); }
    const body={name:document.querySelector('#mat-name').value,code:document.querySelector('#mat-code').value,supplierId:document.querySelector('#mat-supplier').value,facilityId:document.querySelector('#mat-facility').value,availableUnits:Number(document.querySelector('#mat-stock').value),dailyDemand:Number(document.querySelector('#mat-demand').value),leadTimeDays:Number(document.querySelector('#mat-lead').value),transferableUnits:Number(document.querySelector('#mat-transfer').value),unitCost:Number(document.querySelector('#mat-cost').value),currency:'GBP',criticality:document.querySelector('#mat-criticality').value};
    try { state.materials=await api(button.dataset.id?`/api/v1/materials/${encodeURIComponent(button.dataset.id)}`:'/api/v1/materials',{method:button.dataset.id?'PATCH':'POST',key,body}); state.assessment=null; closeDialog(); await loadData(); state.view='materials'; render(); notify('Saved. Inventory cover and shortage figures recalculated.'); } catch(e) { notify(e.message,true); }
    return;
  }
  if (action === 'report-disruption') return disruptionDialog(button.dataset.id);
  if (action === 'submit-disruption') {
    const key=state.keys[state.role]; if(!key||!['ADMIN','MANAGER','OPERATOR'].includes(state.role)){settingsDialog();return notify('Connect an Operator, Manager or Admin key to report disruptions.',true);}
    const m=state.materials?.materials?.find(x=>x.id===button.dataset.id); if(!m)return;
    try { const result=await api('/api/v1/disruptions',{method:'POST',key,body:{supplierId:m.supplierId,itemId:m.id,delayDays:Number(document.querySelector('#event-delay').value),sourceMessage:document.querySelector('#event-message').value}}); state.activeDisruptionId=result.disruption.id; state.assessment=null; closeDialog(); await loadData(); state.view='disruptions'; render(); notify('Disruption created from the saved material record.'); } catch(e) { notify(e.message,true); }
    return;
  }
  if (action === 'refresh-materials') return loadData();
  if (action === 'delete-material') {
    const key=state.keys[state.role]; if (!key || !['ADMIN','MANAGER'].includes(state.role)) { settingsDialog(); return notify('Connect a Manager or Admin key to remove materials.',true); }
    if (!confirm('Remove this material from the register?')) return;
    try { state.materials=await api(`/api/v1/materials/${encodeURIComponent(button.dataset.id)}`,{method:'DELETE',key}); await loadData(); state.view='materials'; render(); notify('Material removed.'); } catch(e) { notify(e.message,true); }
    return;
  }
  if (action === 'assess') return runAssessment();
  if (action === 'save-key') {
    const role = document.querySelector('#role-select').value;
    const key = document.querySelector('#role-key').value.trim();
    if (!key) return notify('Enter a demo role key.', true);
    state.role = role; state.keys[role] = key; closeDialog(); notify(`${role} key stored in this session.`);
    if (state.currentAction?.decision === 'APPROVAL' && ['MANAGER', 'ADMIN'].includes(role)) approvalDialog(state.currentAction);
    return;
  }
  if (action === 'supplier') return loadSupplierRisk(button.dataset.supplier);
  if (action === 'open-risk') { await loadSupplierRisk(button.dataset.supplier); setView('risk'); return; }
  if (action === 'supplier-risk') return loadSupplierRisk(state.selectedSupplier).then(()=>setView('risk'));
  if (action === 'propose') return propose(button.dataset.option);
  if (action === 'approve') return approveAction(true);
  if (action === 'reject') return approveAction(false);
});
overlay.addEventListener('click', (event) => { if (event.target === overlay) closeDialog(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape') closeDialog(); });
window.addEventListener('resize', () => requestAnimationFrame(drawConnections));
loadData();
setInterval(async()=>{if(document.hidden)return;try{const fresh=await api('/api/v1/materials');if(fresh.updatedAt!==state.materials?.updatedAt){state.assessment=null;await loadData();}}catch{}},5000);
