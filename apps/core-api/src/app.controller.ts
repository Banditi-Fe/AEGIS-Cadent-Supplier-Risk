import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { join } from 'node:path';
import { AppService } from './app.service.js';
import { PUBLIC_ASSETS_DIR } from './public-assets.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getDashboard(@Res() response: Response) {
    return response.sendFile(join(PUBLIC_ASSETS_DIR, 'index.html'));
  }

  @Get('health')
  getHealth() {
    return this.appService.getHealth();
  }

  @Get('api/v1/health')
  getVersionedHealth() {
    return this.appService.getHealth();
  }
}
