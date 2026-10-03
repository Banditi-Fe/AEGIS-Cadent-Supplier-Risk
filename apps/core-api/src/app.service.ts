import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHealth() {
    return {
      service: 'core-api' as const,
      status: 'healthy' as const,
      timestamp: new Date().toISOString(),
    };
  }
}
