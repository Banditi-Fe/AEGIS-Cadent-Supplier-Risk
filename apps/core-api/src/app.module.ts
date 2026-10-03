import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { SupplyChainController } from './supply-chain/supply-chain.controller.js';
import { SupplyChainService } from './supply-chain/supply-chain.service.js';

@Module({
  controllers: [AppController, SupplyChainController],
  providers: [AppService, SupplyChainService],
})
export class AppModule {}
