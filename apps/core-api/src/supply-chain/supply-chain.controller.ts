import { Body, Controller, Delete, Get, Headers, Param, Patch, Post, UnauthorizedException, UnprocessableEntityException } from '@nestjs/common';
import { SupplyChainService, secureKeyEquals } from './supply-chain.service.js';

type DemoRole = 'ADMIN' | 'MANAGER' | 'OPERATOR' | 'VIEWER';

@Controller()
export class SupplyChainController {
  constructor(private readonly supplyChain: SupplyChainService) {}

  @Get('api/v1/demo/supply-chain')
  getDemo() { return this.supplyChain.getDemoSnapshot(); }

  @Get('api/v1/materials')
  getMaterials(@Headers('x-organization-id') organizationId?: string) { this.assertOrganization(organizationId); return this.supplyChain.listMaterials(); }

  @Post('api/v1/materials')
  addMaterial(@Body() body: unknown, @Headers('x-demo-role-key') roleKey?: string) { this.requireRole(roleKey, ['ADMIN', 'MANAGER', 'OPERATOR']); return this.supplyChain.saveMaterial(body); }

  @Patch('api/v1/materials/:id')
  updateMaterial(@Param('id') id: string, @Body() body: unknown, @Headers('x-demo-role-key') roleKey?: string) { this.requireRole(roleKey, ['ADMIN', 'MANAGER', 'OPERATOR']); return this.supplyChain.saveMaterial(body, id); }

  @Delete('api/v1/materials/:id')
  removeMaterial(@Param('id') id: string, @Headers('x-demo-role-key') roleKey?: string) { this.requireRole(roleKey, ['ADMIN', 'MANAGER']); return this.supplyChain.deleteMaterial(id); }

  @Get('api/v1/suppliers/network')
  getNetwork(@Headers('x-organization-id') organizationId?: string) {
    this.assertOrganization(organizationId);
    return this.supplyChain.getSupplierNetwork();
  }

  @Get('api/v1/suppliers/:id/risk')
  getSupplierRisk(@Param('id') id: string, @Headers('x-organization-id') organizationId?: string) {
    this.assertOrganization(organizationId);
    return this.supplyChain.getSupplierRiskProfile(id, organizationId as string);
  }

  @Get('api/v1/disruptions')
  listDisruptions(@Headers('x-organization-id') organizationId?: string) {
    this.assertOrganization(organizationId);
    return this.supplyChain.listDisruptions();
  }

  @Post('api/v1/disruptions')
  createDisruption(@Body() body: unknown, @Headers('x-demo-role-key') roleKey?: string) {
    this.requireRole(roleKey, ['ADMIN', 'MANAGER', 'OPERATOR']);
    return this.supplyChain.createDisruption(body);
  }

  @Post('api/v1/disruptions/:id/assess')
  async assessDisruption(@Param('id') id: string, @Headers('x-organization-id') organizationId: string | undefined, @Headers('x-demo-role-key') roleKey?: string) {
    this.requireRole(roleKey, ['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER']);
    this.assertOrganization(organizationId);
    const fallback = this.supplyChain.buildDeterministicAssessment(id, organizationId as string);
    const aiUrl = process.env.AI_ENGINE_URL?.trim().replace(/\/+$/, '');
    const aiKey = process.env.AI_ENGINE_SHARED_SECRET;
    if (!aiUrl || !aiKey) return fallback;
    try {
      const response = await fetch(`${aiUrl}/v1/analyze/disruption`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-service-key': aiKey, 'x-organization-id': organizationId as string },
        body: JSON.stringify({ organizationId, disruptionId: id }),
        signal: AbortSignal.timeout(Number(process.env.AI_ENGINE_TIMEOUT_MS) || 15_000),
      });
      if (!response.ok) return this.supplyChain.buildDeterministicAssessment(id, organizationId as string, `AI Engine returned HTTP ${response.status}; deterministic fallback was used.`);
      const result = await response.json() as Record<string, unknown>;
      if (result.organizationId !== organizationId || result.disruptionId !== id || !Array.isArray(result.options) || !result.recommendation || typeof result.recommendation !== 'object') {
        return this.supplyChain.buildDeterministicAssessment(id, organizationId as string, 'AI Engine response did not match the expected tenant and disruption contract; deterministic fallback was used.');
      }
      return result;
    } catch {
      return this.supplyChain.buildDeterministicAssessment(id, organizationId as string, 'AI Engine was unavailable; deterministic fallback was used.');
    }
  }

  @Post('api/v1/disruptions/:id/decide')
  decide(@Param('id') id: string, @Body() body: unknown, @Headers('x-demo-role-key') roleKey?: string) {
    const role = this.requireRole(roleKey, ['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER']);
    if (!body || typeof body !== 'object') throw new UnprocessableEntityException('Request body must be an object.');
    const value = body as Record<string, unknown>;
    return this.supplyChain.decide(id, { organizationId: value.organizationId, optionId: value.optionId }, role);
  }

  @Post('api/v1/recovery-actions/:id/approve')
  approve(@Param('id') id: string, @Body() body: unknown, @Headers('x-demo-role-key') roleKey?: string) {
    const role = this.requireRole(roleKey, ['ADMIN', 'MANAGER']);
    if (!body || typeof body !== 'object' || typeof (body as Record<string, unknown>).approved !== 'boolean') {
      throw new UnprocessableEntityException('approved must be a boolean.');
    }
    return this.supplyChain.approveAction(id, role, (body as Record<string, unknown>).approved as boolean);
  }

  @Get('api/v1/integrations/ariba/status')
  getAribaStatus(@Headers('x-organization-id') organizationId?: string) {
    this.assertOrganization(organizationId);
    return this.supplyChain.getAribaStatus();
  }

  /** Internal data for the read-only AI Engine. The organization is always checked against the resource. */
  @Get('internal/v1/health')
  internalHealth(@Headers('x-service-key') key?: string) {
    this.assertInternalKey(key);
    return { status: 'ok', service: 'core-api', mode: 'supplier-risk-demo' };
  }

  @Get('internal/v1/disruptions/:id/context')
  internalDisruptionContext(@Param('id') id: string, @Headers('x-service-key') key?: string, @Headers('x-organization-id') organizationId?: string) {
    this.assertInternalKey(key);
    this.assertOrganization(organizationId);
    return this.supplyChain.getDisruptionContext(id, organizationId as string);
  }

  private assertInternalKey(key?: string): void {
    if (!secureKeyEquals(key, process.env.INTERNAL_SERVICE_KEY)) throw new UnauthorizedException('Invalid or missing service key.');
  }

  private assertOrganization(organizationId?: string): void {
    if (organizationId !== this.supplyChain.organizationId) throw new UnauthorizedException('A valid demo organization scope is required.');
  }

  private requireRole(key: string | undefined, allowed: DemoRole[]): DemoRole {
    const roles: DemoRole[] = ['ADMIN', 'MANAGER', 'OPERATOR', 'VIEWER'];
    const matched = roles.find((role) => secureKeyEquals(key, process.env[`DEMO_${role}_KEY`]));
    if (!matched || !allowed.includes(matched)) throw new UnauthorizedException('A valid role-specific demo key is required for this operation.');
    return matched;
  }
}
