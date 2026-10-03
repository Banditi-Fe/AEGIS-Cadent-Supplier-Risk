import { SupplyChainService } from './supply-chain.service.js';

describe('SupplyChainService', () => {
  let service: SupplyChainService;
  beforeEach(() => { service = new SupplyChainService(); });

  it('maps a tier-2 delay through tier-1 suppliers to an affected service facility', () => {
    const context = service.getDisruptionContext('DSP-DEMO-001', 'cadent-demo');
    expect(context.disruption.affectedSupplierIds).toContain('SUP-T1-ATLAS');
    expect(context.supplierNetwork.map((supplier) => supplier.tier)).toContain(3);
    expect(context.impacts[0]).toMatchObject({ daysOfCover: 4, delayDays: 10, uncoveredDays: 6, shortageUnits: 3000 });
    expect(context.impacts[0]?.shortageAt).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('compares recovery options with explicit costs, residual shortages and evidence', () => {
    const context = service.getDisruptionContext('DSP-DEMO-001', 'cadent-demo');
    const transfer = context.options.find((option) => option.id === 'OPT-TRANSFER-DEPOT-BIR');
    expect(transfer).toMatchObject({ feasible: true, estimatedCost: 18000, currency: 'GBP', quantityUnits: 3000, residualShortageUnits: 0, requiresApproval: true });
    expect(transfer?.evidenceIds.every((id) => context.evidence.some((entry) => entry.evidenceId === id))).toBe(true);
    expect(context.options.find((option) => option.id === 'OPT-APPROVED-ALTERNATE')).toMatchObject({ feasible: false, residualShortageUnits: 3000 });
  });

  it('covers Cadent-style supplier risk categories and marks missing feeds UNKNOWN', () => {
    const profile = service.getSupplierRiskProfile('SUP-T2-ALLOY', 'cadent-demo');
    expect(profile.categories.map((signal) => signal.category).sort()).toEqual([
      'BUSINESS_CONTINUITY', 'COMPLIANCE', 'CYBER', 'ESG', 'FINANCIAL', 'GEOPOLITICAL', 'OPERATIONAL', 'REPUTATIONAL',
    ]);
    expect(profile.categories.find((signal) => signal.category === 'CYBER')?.level).toBe('UNKNOWN');
    expect(profile.categories.find((signal) => signal.category === 'OPERATIONAL')?.level).toBe('HIGH');
  });

  it('does not reveal disruptions across organization boundaries', () => {
    expect(() => service.getDisruptionContext('DSP-DEMO-001', 'another-tenant')).toThrow();
  });

  it('requires a human for material transfer, blocks viewers and records simulated approval', () => {
    const pending = service.decide('DSP-DEMO-001', { organizationId: 'cadent-demo', optionId: 'OPT-TRANSFER-DEPOT-BIR' }, 'MANAGER');
    expect(pending).toMatchObject({ decision: 'APPROVAL', status: 'PENDING_APPROVAL', executionMode: 'SIMULATED_ONLY' });
    const blocked = service.decide('DSP-DEMO-001', { organizationId: 'cadent-demo', optionId: 'OPT-TRANSFER-DEPOT-BIR' }, 'VIEWER');
    expect(blocked.decision).toBe('BLOCKED');
    const approved = service.approveAction(pending.id, 'MANAGER', true);
    expect(approved.status).toBe('APPROVED_IN_SIMULATION');
    expect(approved.audit.at(-1)?.type).toBe('RECOVERY_APPROVED');
  });

  it('fails closed on an unqualified alternate supplier', () => {
    const blocked = service.decide('DSP-DEMO-001', { organizationId: 'cadent-demo', optionId: 'OPT-APPROVED-ALTERNATE' }, 'ADMIN');
    expect(blocked.decision).toBe('BLOCKED');
    expect(blocked.status).toBe('BLOCKED');
  });
});
