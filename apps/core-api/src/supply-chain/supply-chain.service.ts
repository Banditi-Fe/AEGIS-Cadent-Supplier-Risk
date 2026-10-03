import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type RiskCategory = 'FINANCIAL' | 'OPERATIONAL' | 'BUSINESS_CONTINUITY' | 'CYBER' | 'ESG' | 'COMPLIANCE' | 'GEOPOLITICAL' | 'REPUTATIONAL';
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' | 'UNKNOWN';
export type OptionType = 'TRANSFER_STOCK' | 'EXPEDITE_SUPPLY' | 'APPROVED_ALTERNATE' | 'RESCHEDULE_WORK' | 'MONITOR';
export type Decision = 'AUTO' | 'APPROVAL' | 'BLOCKED';

export interface Supplier {
  id: string; name: string; tier: number; status: 'ACTIVE' | 'AT_RISK' | 'SUSPENDED' | 'UNKNOWN';
  criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; parentSupplierIds: string[]; aribaSupplierId?: string;
}
export interface Disruption {
  id: string; organizationId: string; supplierId: string; itemId: string; delayDays: number;
  reportedAt: string; sourceMessage: string; status: 'OPEN' | 'ASSESSED' | 'RESOLVED';
}
export interface MaterialRecord {
  id: string; code: string; name: string; supplierId: string; facilityId: string;
  availableUnits: number; dailyDemand: number; leadTimeDays: number; transferableUnits: number;
  unitCost: number; currency: string; criticality: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; updatedAt: string;
}
interface RecoveryAction {
  id: string; organizationId: string; disruptionId: string; optionId: string; decision: Decision;
  status: 'PENDING_APPROVAL' | 'PREPARED_IN_SIMULATION' | 'BLOCKED' | 'APPROVED_IN_SIMULATION' | 'REJECTED';
  requestedByRole: string; reason: string; createdAt: string; audit: Array<{ type: string; at: string; actor: string; detail: string }>;
}

const RISK_CATEGORIES: RiskCategory[] = ['FINANCIAL', 'OPERATIONAL', 'BUSINESS_CONTINUITY', 'CYBER', 'ESG', 'COMPLIANCE', 'GEOPOLITICAL', 'REPUTATIONAL'];
const nowIso = (): string => new Date().toISOString();

@Injectable()
export class SupplyChainService {
  readonly organizationId = 'cadent-demo';
  readonly demoData = true;
  private readonly suppliers: Supplier[] = [
    { id: 'SUP-T1-ATLAS', name: 'Atlas Flow Controls Ltd. (synthetic)', tier: 1, status: 'AT_RISK', criticality: 'CRITICAL', parentSupplierIds: ['SUP-T2-ALLOY', 'SUP-T2-FREIGHT'], aribaSupplierId: 'ARIBA-DEMO-1001' },
    { id: 'SUP-T2-ALLOY', name: 'Northern Alloy Works (synthetic)', tier: 2, status: 'AT_RISK', criticality: 'CRITICAL', parentSupplierIds: ['SUP-T3-CASTING'], aribaSupplierId: 'ARIBA-DEMO-2044' },
    { id: 'SUP-T2-FREIGHT', name: 'Northline Logistics (synthetic)', tier: 2, status: 'ACTIVE', criticality: 'HIGH', parentSupplierIds: [], aribaSupplierId: 'ARIBA-DEMO-2020' },
    { id: 'SUP-T3-CASTING', name: 'Foundry Components Group (synthetic)', tier: 3, status: 'AT_RISK', criticality: 'HIGH', parentSupplierIds: [], aribaSupplierId: 'ARIBA-DEMO-3310' },
    { id: 'SUP-ALT-QUAL', name: 'Westmoor Industrial Supply (synthetic)', tier: 1, status: 'ACTIVE', criticality: 'MEDIUM', parentSupplierIds: [], aribaSupplierId: 'ARIBA-DEMO-1880' },
  ];
  private readonly materialsFile = join(process.cwd(), 'data', 'materials.json');
  private materials: MaterialRecord[] = this.loadMaterials();
  private get item() { const m = this.materials.find((x) => x.id === 'MAT-DN300-REG')!; return { id: m.id, name: m.name, currency: m.currency }; }
  private readonly disruptions = new Map<string, Disruption>([[ 'DSP-DEMO-001', {
    id: 'DSP-DEMO-001', organizationId: this.organizationId, supplierId: 'SUP-T2-ALLOY', itemId: this.item.id,
    delayDays: 10, reportedAt: nowIso(), sourceMessage: 'SIMULATED SUPPLIER NOTICE: Casting line outage. The batch of DN300 regulator valves is delayed by 10 days.', status: 'OPEN',
  }]]);
  private readonly actions = new Map<string, RecoveryAction>();

  getHealth() { return { service: 'core-api', status: 'healthy', mode: 'supplier-risk-demo', timestamp: nowIso() }; }

  private loadMaterials(): MaterialRecord[] {
    try { return JSON.parse(readFileSync(this.materialsFile, 'utf8')) as MaterialRecord[]; }
    catch { return [{ id: 'MAT-DN300-REG', code: 'DN300-REG', name: 'DN300 pressure regulator valve', supplierId: 'SUP-T2-ALLOY', facilityId: 'DEPOT-MAN', availableUnits: 2000, dailyDemand: 500, leadTimeDays: 10, transferableUnits: 4000, unitCost: 42, currency: 'GBP', criticality: 'CRITICAL', updatedAt: nowIso() }]; }
  }
  private saveMaterials() { mkdirSync(dirname(this.materialsFile), { recursive: true }); writeFileSync(this.materialsFile, JSON.stringify(this.materials, null, 2), 'utf8'); }
  listMaterials() {
    const items = this.materials.map((m) => ({ ...m, daysOfCover: m.dailyDemand ? Math.round((m.availableUnits / m.dailyDemand) * 10) / 10 : 0, shortageUnits: Math.max(0, m.leadTimeDays * m.dailyDemand - m.availableUnits), stockValue: m.availableUnits * m.unitCost }));
    const updatedAt = items.reduce((latest, m) => m.updatedAt > latest ? m.updatedAt : latest, '') || nowIso();
    return { organizationId: this.organizationId, updatedAt, materials: items, statistics: { materialCount: items.length, atRiskCount: items.filter((m) => m.daysOfCover < m.leadTimeDays).length, availableUnits: items.reduce((n, m) => n + m.availableUnits, 0), estimatedStockValue: items.reduce((n, m) => n + m.stockValue, 0) } };
  }
  saveMaterial(input: unknown, id?: string) {
    if (!input || typeof input !== 'object') throw new UnprocessableEntityException('Material fields are required.');
    const body = input as Record<string, unknown>;
    const existing = id ? this.materials.find((m) => m.id === id) : undefined;
    if (id && !existing) throw new NotFoundException('Material not found.');
    const text = (key: string, fallback = '') => typeof body[key] === 'string' ? (body[key] as string).trim() : fallback;
    const previousNumbers: Record<string, number> = existing ? { availableUnits: existing.availableUnits, dailyDemand: existing.dailyDemand, leadTimeDays: existing.leadTimeDays, transferableUnits: existing.transferableUnits, unitCost: existing.unitCost } : {};
    const num = (key: string, fallback: number) => body[key] === undefined && existing ? previousNumbers[key] : Number(body[key] ?? fallback);
    const name = text('name', existing?.name); const code = text('code', existing?.code).toUpperCase();
    const supplierId = text('supplierId', existing?.supplierId); const facilityId = text('facilityId', existing?.facilityId || 'DEPOT-MAN');
    const availableUnits = num('availableUnits', 0), dailyDemand = num('dailyDemand', 1), leadTimeDays = num('leadTimeDays', 1), transferableUnits = num('transferableUnits', 0), unitCost = num('unitCost', 0);
    if (!name || !code || name.length > 120 || code.length > 32) throw new UnprocessableEntityException('Enter a material name and code (max 120 and 32 characters).');
    if (!this.suppliers.some((s) => s.id === supplierId)) throw new UnprocessableEntityException('Choose a supplier from the supplier network.');
    if (!['DEPOT-MAN', 'DEPOT-BIR'].includes(facilityId)) throw new UnprocessableEntityException('Choose a supported network depot.');
    if (![availableUnits, dailyDemand, leadTimeDays, transferableUnits, unitCost].every(Number.isFinite) || availableUnits < 0 || dailyDemand <= 0 || leadTimeDays <= 0 || transferableUnits < 0 || unitCost < 0) throw new UnprocessableEntityException('Stock, demand, lead time, transfer units and cost must be valid positive numbers (stock and transfer can be zero).');
    if (this.materials.some((m) => m.code.toLowerCase() === code.toLowerCase() && m.id !== id)) throw new UnprocessableEntityException('A material with this code already exists.');
    const criticality = text('criticality', existing?.criticality || 'MEDIUM').toUpperCase();
    if (!['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(criticality)) throw new UnprocessableEntityException('Choose a valid criticality.');
    const currency = text('currency', existing?.currency || 'GBP').toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new UnprocessableEntityException('Currency must be a three-letter code.');
    const record: MaterialRecord = { id: id || `MAT-${randomUUID().slice(0, 8).toUpperCase()}`, code, name, supplierId, facilityId, availableUnits, dailyDemand, leadTimeDays, transferableUnits, unitCost, currency, criticality: criticality as MaterialRecord['criticality'], updatedAt: nowIso() };
    const index = this.materials.findIndex((m) => m.id === record.id);
    if (index >= 0) this.materials[index] = record; else this.materials.push(record);
    this.saveMaterials();
    return this.listMaterials();
  }
  deleteMaterial(id: string) {
    if (id === 'MAT-DN300-REG') throw new UnprocessableEntityException('The material attached to the open disruption cannot be removed.');
    if ([...this.disruptions.values()].some((disruption) => disruption.itemId === id)) throw new UnprocessableEntityException('This material is linked to a disruption and cannot be removed.');
    const before = this.materials.length; this.materials = this.materials.filter((m) => m.id !== id);
    if (before === this.materials.length) throw new NotFoundException('Material not found.');
    this.saveMaterials(); return this.listMaterials();
  }

  getDemoSnapshot() {
    const disruption = [...this.disruptions.values()][0];
    const primary = this.materials.find((m) => m.id === 'MAT-DN300-REG')!;
    return {
      organizationId: this.organizationId,
      demoData: true,
      notice: 'All companies, supplier records, risk signals, inventory and costs in this demonstration are synthetic; this is not Cadent Gas data and no live SAP Ariba connection is configured.',
      riskCategories: RISK_CATEGORIES,
      suppliers: this.suppliers,
      item: this.item,
      materials: this.listMaterials(),
      facilities: [
        { id: 'DEPOT-MAN', name: 'Manchester Network Depot (sample)', serviceArea: 'North West', availableUnits: primary.facilityId === 'DEPOT-MAN' ? primary.availableUnits : 0, dailyDemand: primary.facilityId === 'DEPOT-MAN' ? primary.dailyDemand : 0, onHandUnits: primary.facilityId === 'DEPOT-MAN' ? primary.availableUnits : 0, reservedUnits: 0, safetyStockUnits: 0 },
        { id: 'DEPOT-BIR', name: 'Birmingham Network Depot (sample)', serviceArea: 'West Midlands', availableUnits: primary.facilityId === 'DEPOT-BIR' ? primary.availableUnits : primary.transferableUnits, dailyDemand: primary.facilityId === 'DEPOT-BIR' ? primary.dailyDemand : 0, onHandUnits: primary.facilityId === 'DEPOT-BIR' ? primary.availableUnits : primary.transferableUnits, reservedUnits: 0, safetyStockUnits: 0 },
      ],
      disruptions: [...this.disruptions.values()],
      ariba: this.getAribaStatus(),
      suggestedDemoDisruptionId: disruption?.id,
    };
  }

  listDisruptions() {
    return { organizationId: this.organizationId, demoData: true, data: [...this.disruptions.values()].map((d) => this.buildContext(d)) };
  }

  createDisruption(input: unknown) {
    if (!input || typeof input !== 'object') throw new UnprocessableEntityException('Request body must be an object.');
    const body = input as Record<string, unknown>;
    const supplierId = typeof body.supplierId === 'string' ? body.supplierId : '';
    const itemId = typeof body.itemId === 'string' ? body.itemId : '';
    const delayDays = body.delayDays;
    const sourceMessage = typeof body.sourceMessage === 'string' ? body.sourceMessage.trim() : '';
    if (!this.suppliers.some((s) => s.id === supplierId)) throw new UnprocessableEntityException('Unknown supplierId. Use a supplier in the demo network.');
    if (!this.materials.some((m) => m.id === itemId)) throw new UnprocessableEntityException('Unknown itemId. Add the material to the materials register first.');
    if (!Number.isInteger(delayDays) || Number(delayDays) < 1 || Number(delayDays) > 90) throw new UnprocessableEntityException('delayDays must be an integer from 1 to 90.');
    if (sourceMessage.length < 8 || sourceMessage.length > 1000) throw new UnprocessableEntityException('sourceMessage must be 8 to 1000 characters.');
    const id = `DSP-${randomUUID().slice(0, 8).toUpperCase()}`;
    const disruption: Disruption = { id, organizationId: this.organizationId, supplierId, itemId, delayDays: Number(delayDays), reportedAt: nowIso(), sourceMessage, status: 'OPEN' };
    this.disruptions.set(id, disruption);
    return this.buildContext(disruption);
  }

  getDisruptionContext(id: string, organizationId: string) {
    if (organizationId !== this.organizationId) throw new NotFoundException('Disruption not found.');
    const disruption = this.disruptions.get(id);
    if (!disruption || disruption.organizationId !== organizationId) throw new NotFoundException('Disruption not found.');
    return this.buildContext(disruption);
  }

  buildDeterministicAssessment(id: string, organizationId: string, extraUncertainty?: string) {
    const context = this.getDisruptionContext(id, organizationId);
    const best = [...context.options].filter((option) => option.feasible)
      .sort((a, b) => a.residualShortageUnits - b.residualShortageUnits || a.estimatedCost - b.estimatedCost || a.arrivesInDays - b.arrivesInDays)[0];
    const impacted = context.impacts.filter((impact) => impact.shortageUnits > 0);
    const warnings = [...context.dataWarnings, ...(extraUncertainty ? [extraUncertainty] : [])];
    return {
      schemaVersion: '1.0', agentRunId: `fallback-${randomUUID()}`, organizationId, disruptionId: id,
      status: 'DEGRADED',
      summary: impacted.length
        ? `${impacted.length} service location(s) show a projected ${context.disruption.delayDays}-day supplier delay. ${impacted.reduce((sum, item) => sum + item.shortageUnits, 0).toLocaleString('en-GB')} units are uncovered in the supplied scenario data.`
        : 'The available scenario data shows no uncovered demand from this disruption.',
      riskLevel: impacted.some((impact) => impact.serviceCriticality === 'CRITICAL') ? 'CRITICAL' : impacted.length ? 'HIGH' : 'MEDIUM',
      impacts: context.impacts,
      options: context.options,
      recommendation: {
        optionId: best?.id ?? null,
        rationale: best ? `Deterministic fallback selected the feasible option with the smallest residual shortage, then the lowest estimated cost. ${best.constraints.join(' ')}` : 'No feasible recovery option is available from the supplied data.',
        confidence: best ? 0.55 : 0.3,
        citedEvidenceIds: best?.evidenceIds ?? [],
      },
      uncertainties: warnings,
      evidence: context.evidence,
      toolTrace: [{ step: 1, name: 'Load tenant-scoped disruption context', status: 'SUCCESS', durationMs: 0, evidenceCount: context.evidence.length }, { step: 2, name: 'Use deterministic recovery fallback', status: 'SUCCESS', durationMs: 0, evidenceCount: best?.evidenceIds.length ?? 0 }],
      model: { provider: 'deterministic', name: 'safe-fallback', latencyMs: 0, status: 'UNAVAILABLE' },
    };
  }

  getAribaStatus() {
    return {
      provider: 'SAP Ariba Risk', mode: 'SIMULATED_ADAPTER', connected: false,
      note: 'This prototype maps synthetic supplier IDs to Ariba-style IDs. It does not authenticate to, read from, or write to SAP Ariba.',
      capabilities: ['supplier-risk-import-contract', 'supplier-id-mapping', 'action-export-preview'],
      lastSyncAt: null,
    };
  }

  getSupplierNetwork() {
    return { organizationId: this.organizationId, demoData: true, data: this.suppliers.map((supplier) => ({ ...supplier })) };
  }

  getSupplierRiskProfile(supplierId: string, organizationId: string) {
    if (organizationId !== this.organizationId) throw new NotFoundException('Supplier not found.');
    const supplier = this.suppliers.find((candidate) => candidate.id === supplierId);
    if (!supplier) throw new NotFoundException('Supplier not found.');
    const evidence: Array<{ evidenceId: string; source: string; sourceRecordId: string; field: string; value: string | number | boolean | null; observedAt: string; freshness: 'CURRENT' | 'STALE' | 'UNKNOWN' }> = [];
    const add = (source: string, record: string, field: string, value: string | number | boolean | null, freshness?: 'CURRENT' | 'STALE' | 'UNKNOWN') => {
      const evidenceId = `${source}:${record}:${field}`;
      if (!evidence.some((entry) => entry.evidenceId === evidenceId)) evidence.push({ evidenceId, source, sourceRecordId: record, field, value, observedAt: nowIso(), freshness: freshness ?? 'CURRENT' });
      return evidenceId;
    };
    return { organizationId, demoData: true, supplier, categories: this.makeRiskSignals(supplierId, add), evidence };
  }

  decide(disruptionId: string, input: unknown, role: string) {
    if (!input || typeof input !== 'object') throw new UnprocessableEntityException('Request body must be an object.');
    const body = input as Record<string, unknown>;
    const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
    const optionId = typeof body.optionId === 'string' ? body.optionId : '';
    const context = this.getDisruptionContext(disruptionId, organizationId);
    const option = context.options.find((candidate) => candidate.id === optionId);
    if (!option) throw new UnprocessableEntityException('optionId must refer to an option returned by this disruption assessment.');
    let decision: Decision = 'APPROVAL';
    let reason = 'Human review is required for supply-chain recovery actions in this demo.';
    if (!option.feasible) { decision = 'BLOCKED'; reason = option.constraints.join(' ') || 'Option is infeasible.'; }
    else if (role === 'VIEWER') { decision = 'BLOCKED'; reason = 'VIEWER role cannot request a recovery action.'; }
    else if (!option.requiresApproval && option.estimatedCost <= 10_000 && option.type === 'MONITOR') { decision = 'AUTO'; reason = 'Low-impact monitoring action is inside the demo auto-execution policy.'; }

    const id = `RA-${randomUUID().slice(0, 8).toUpperCase()}`;
    const status: RecoveryAction['status'] = decision === 'BLOCKED' ? 'BLOCKED' : decision === 'AUTO' ? 'PREPARED_IN_SIMULATION' : 'PENDING_APPROVAL';
    const action: RecoveryAction = {
      id, organizationId, disruptionId, optionId, decision, status, requestedByRole: role, reason, createdAt: nowIso(),
      audit: [{ type: 'RECOVERY_PROPOSED', at: nowIso(), actor: role || 'UNKNOWN', detail: `Option ${optionId} evaluated by Core policy.` }],
    };
    this.actions.set(id, action);
    return { ...action, executionMode: 'SIMULATED_ONLY', nextStep: status === 'PENDING_APPROVAL' ? 'A MANAGER or ADMIN must approve this action.' : status === 'PREPARED_IN_SIMULATION' ? 'The action is marked as prepared in the simulator; no physical stock or purchase order was changed.' : 'No action was executed.' };
  }

  approveAction(actionId: string, role: string, approved: boolean) {
    const action = this.actions.get(actionId);
    if (!action) throw new NotFoundException('Recovery action not found.');
    if (role !== 'ADMIN' && role !== 'MANAGER') throw new UnprocessableEntityException('Only ADMIN or MANAGER may approve or reject recovery actions.');
    if (action.status !== 'PENDING_APPROVAL') throw new UnprocessableEntityException('Recovery action is not awaiting approval.');
    action.status = approved ? 'APPROVED_IN_SIMULATION' : 'REJECTED';
    action.audit.push({ type: approved ? 'RECOVERY_APPROVED' : 'RECOVERY_REJECTED', at: nowIso(), actor: role, detail: approved ? 'Approved in simulation only; no external system was changed.' : 'Rejected by reviewer.' });
    return { ...action, executionMode: 'SIMULATED_ONLY', nextStep: approved ? 'Approved in the simulator only; connect an authorized executor to place a real transfer or purchase order.' : 'Action rejected; no external system was changed.' };
  }

  private buildContext(disruption: Disruption) {
    const reportedAt = disruption.reportedAt;
    const material = this.materials.find((m) => m.id === disruption.itemId);
    if (!material) throw new NotFoundException('Material linked to disruption was removed.');
    const supplier = this.suppliers.find((s) => s.id === material.supplierId);
    if (!supplier) throw new NotFoundException('Supplier not found.');
    const affectedSuppliers = this.suppliers.filter((s) => s.id === supplier.id || this.dependsOn(s, supplier.id)).map((s) => s.id);
    const evidence: Array<{ evidenceId: string; source: string; sourceRecordId: string; field: string; value: string | number | boolean | null; observedAt: string; freshness: 'CURRENT' | 'STALE' | 'UNKNOWN' }> = [];
    const addEvidence = (source: string, record: string, field: string, value: string | number | boolean | null, freshness: 'CURRENT' | 'STALE' | 'UNKNOWN' = 'CURRENT') => {
      const evidenceId = `${source}:${record}:${field}`;
      if (!evidence.some((e) => e.evidenceId === evidenceId)) evidence.push({ evidenceId, source, sourceRecordId: record, field, value, observedAt: reportedAt, freshness });
      return evidenceId;
    };
    const eSupplier = addEvidence('SIMULATED_ARIBA', supplier.id, 'supplierStatus', supplier.status);
    const eDelay = addEvidence('SIMULATED_SUPPLIER_NOTICE', disruption.id, 'delayDays', disruption.delayDays);
    const eNotice = addEvidence('SIMULATED_SUPPLIER_NOTICE', disruption.id, 'message', disruption.sourceMessage);
    const facilityName = material.facilityId === 'DEPOT-BIR' ? 'Birmingham Network Depot (synthetic)' : 'Manchester Network Depot (synthetic)';
    const eInventory = addEvidence('LOCAL_MATERIALS_REGISTER', material.id, 'availableUnits', material.availableUnits);
    const eDemand = addEvidence('LOCAL_MATERIALS_REGISTER', material.id, 'dailyDemand', material.dailyDemand);
    const eDonor = addEvidence('LOCAL_MATERIALS_REGISTER', material.id, 'transferableUnits', material.transferableUnits);
    const daysOfCover = material.availableUnits / material.dailyDemand;
    const shortageUnits = Math.max(0, disruption.delayDays - daysOfCover) * material.dailyDemand;
    const shortageAt = new Date(new Date(reportedAt).getTime() + daysOfCover * 86_400_000).toISOString();
    const impacts = [{
      facilityId: material.facilityId, facilityName, serviceArea: material.facilityId === 'DEPOT-BIR' ? 'West Midlands' : 'North West', itemId: material.id, itemName: material.name,
      availableUnits: material.availableUnits, dailyDemand: material.dailyDemand, daysOfCover, shortageAt, delayDays: disruption.delayDays,
      uncoveredDays: Math.max(0, disruption.delayDays - daysOfCover), shortageUnits, serviceCriticality: material.criticality,
      evidenceIds: [eInventory, eDemand, eDelay],
    }];
    const transferQty = Math.min(shortageUnits, material.transferableUnits);
    const optionEvidence = [eInventory, eDemand, eDonor, eDelay];
    const options = [
      {
        id: 'OPT-TRANSFER-DEPOT-BIR', type: 'TRANSFER_STOCK' as const, title: 'Transfer available valves from Birmingham depot',
        description: `Move ${transferQty.toLocaleString('en-GB')} valves to Manchester; the source depot retains its stated safety stock.`,
        feasible: transferQty > 0, estimatedCost: transferQty * 6, currency: 'GBP', arrivesInDays: 2, quantityUnits: transferQty,
        shortageDaysCovered: Math.min(impacts[0].uncoveredDays, transferQty / material.dailyDemand), residualShortageUnits: Math.max(0, shortageUnits - transferQty),
        constraints: transferQty > 0 ? ['Source inventory must be rechecked before execution.', 'Inter-depot transfer requires a MANAGER approval in the demo policy.'] : ['No shortage quantity to transfer.'],
        requiresApproval: true, evidenceIds: optionEvidence,
      },
      {
        id: 'OPT-EXPEDITE-PRIMARY', type: 'EXPEDITE_SUPPLY' as const, title: 'Request an expedited shipment from the affected supplier',
        description: 'Request an expedited shipment sized to cover the calculated shortfall; delivery timing must be confirmed by the supplier.',
        feasible: shortageUnits > 0, estimatedCost: shortageUnits * 9, currency: 'GBP', arrivesInDays: 3, quantityUnits: shortageUnits,
        shortageDaysCovered: Math.min(impacts[0].uncoveredDays, shortageUnits / material.dailyDemand), residualShortageUnits: 0,
        constraints: ['Expedite lead time and quantity are illustrative estimates; obtain a supplier confirmation before ordering.'],
        requiresApproval: true, evidenceIds: [eDelay, eNotice],
      },
      {
        id: 'OPT-APPROVED-ALTERNATE', type: 'APPROVED_ALTERNATE' as const, title: 'Check the alternate supplier qualification before sourcing',
        description: 'Westmoor is present in the synthetic supplier directory, but the demo contains no current quality or capacity approval for this valve.',
        feasible: false, estimatedCost: shortageUnits * 7, currency: 'GBP', arrivesInDays: 5, quantityUnits: shortageUnits,
        shortageDaysCovered: 0, residualShortageUnits: shortageUnits,
        constraints: ['BLOCKED: supplier qualification, product equivalence, capacity and required certificates are not evidenced.'],
        requiresApproval: true, evidenceIds: [eDelay],
      },
      {
        id: 'OPT-RESCHEDULE-WORK', type: 'RESCHEDULE_WORK' as const, title: 'Defer non-critical planned work in the affected service area',
        description: 'Reschedule only work that the responsible operations planner confirms is safe to defer; no work-order data is included in this demo.',
        feasible: false, estimatedCost: 5000, currency: 'GBP', arrivesInDays: 0, quantityUnits: 0,
        shortageDaysCovered: 0, residualShortageUnits: shortageUnits,
        constraints: ['BLOCKED: no work-order criticality or safety deferral approval is available in the demo data.'],
        requiresApproval: true, evidenceIds: [eDelay],
      },
      {
        id: 'OPT-MONITOR-SUPPLIER', type: 'MONITOR' as const, title: 'Create a supplier confirmation and monitoring task',
        description: 'Record the delay, request a confirmed recovery date, and keep the affected material on the watchlist.',
        feasible: true, estimatedCost: 0, currency: 'GBP', arrivesInDays: 0, quantityUnits: 0,
        shortageDaysCovered: 0, residualShortageUnits: shortageUnits,
        constraints: ['Monitoring does not prevent the projected stockout by itself.'],
        requiresApproval: false, evidenceIds: [eSupplier, eDelay, eNotice],
      },
    ];

    const riskSignals = this.makeRiskSignals(supplier.id, addEvidence);
    const network = this.suppliers.map((s) => ({ ...s }));
    const selectedSuppliers = network.filter((s) => affectedSuppliers.includes(s.id));
    const dataWarnings = [
      'All organizations, suppliers, inventory, risk feeds, costs and relationships are synthetic demonstration records.',
      'Cyber, ESG, geopolitical, reputational and some financial evidence is unavailable; UNKNOWN means not assessed, not low risk.',
      'Inventory snapshots and transfer/expedite quantities must be confirmed in the source systems before any real action.',
      'The SAP Ariba Risk adapter is simulated and is not connected to Cadent or SAP.',
    ];
    return {
      organizationId: disruption.organizationId, demoData: true,
      disruption: { ...disruption, supplierId: material.supplierId, supplierName: supplier.name, affectedSupplierIds: affectedSuppliers, itemName: material.name },
      supplierNetwork: selectedSuppliers,
      riskSignals, impacts, options, evidence, dataWarnings,
    };
  }

  private dependsOn(supplier: Supplier, ancestorId: string): boolean {
    const pending = [...supplier.parentSupplierIds];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop() as string;
      if (id === ancestorId) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      pending.push(...(this.suppliers.find((candidate) => candidate.id === id)?.parentSupplierIds ?? []));
    }
    return false;
  }

  private makeRiskSignals(supplierId: string, addEvidence: (source: string, record: string, field: string, value: string | number | boolean | null, freshness?: 'CURRENT' | 'STALE' | 'UNKNOWN') => string) {
    const definitions: Array<{ category: RiskCategory; level: RiskLevel; title: string; summary: string; source: string; field: string; value: string }> = [
      { category: 'FINANCIAL', level: 'UNKNOWN', title: 'Financial risk feed unavailable', summary: 'No financial health feed is included in the synthetic scenario.', source: 'NO_DEMO_FEED', field: 'coverage', value: 'UNKNOWN' },
      { category: 'OPERATIONAL', level: 'HIGH', title: 'Tier-2 casting delay reported', summary: 'A reported casting delay may affect the tier-1 valve supplier.', source: 'SIMULATED_SUPPLIER_NOTICE', field: 'delayDays', value: '10' },
      { category: 'BUSINESS_CONTINUITY', level: 'HIGH', title: 'Single critical upstream route in the scenario', summary: 'The demo network has no verified second qualified source for this material.', source: 'SIMULATED_SUPPLY_NETWORK', field: 'qualifiedAlternateCount', value: '0' },
      { category: 'CYBER', level: 'UNKNOWN', title: 'Cyber risk feed unavailable', summary: 'No cyber monitoring evidence is included in the synthetic scenario.', source: 'NO_DEMO_FEED', field: 'coverage', value: 'UNKNOWN' },
      { category: 'ESG', level: 'UNKNOWN', title: 'ESG evidence unavailable', summary: 'No current ESG assessment is included in the synthetic scenario.', source: 'NO_DEMO_FEED', field: 'coverage', value: 'UNKNOWN' },
      { category: 'COMPLIANCE', level: 'UNKNOWN', title: 'Supplier certificate status not verified', summary: 'Required product and supplier certificates are not available in this demo.', source: 'NO_DEMO_FEED', field: 'certificateStatus', value: 'UNKNOWN' },
      { category: 'GEOPOLITICAL', level: 'UNKNOWN', title: 'Geopolitical feed unavailable', summary: 'No route or country-risk feed is included in the synthetic scenario.', source: 'NO_DEMO_FEED', field: 'coverage', value: 'UNKNOWN' },
      { category: 'REPUTATIONAL', level: 'UNKNOWN', title: 'Reputational risk feed unavailable', summary: 'No reputational monitoring evidence is included in the synthetic scenario.', source: 'NO_DEMO_FEED', field: 'coverage', value: 'UNKNOWN' },
    ];
    return definitions.map((d) => {
      const id = addEvidence(d.source, supplierId, d.field, d.value, d.level === 'UNKNOWN' ? 'UNKNOWN' : 'CURRENT');
      return { id: `SIG-${supplierId}-${d.category}`, supplierId, category: d.category, level: d.level, title: d.title, summary: d.summary, source: d.source, observedAt: nowIso(), evidenceIds: [id] };
    });
  }
}

/** Constant-time compare for demo-only write access and AI-to-Core read access. */
export function secureKeyEquals(provided: string | undefined, expected: string | undefined): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
