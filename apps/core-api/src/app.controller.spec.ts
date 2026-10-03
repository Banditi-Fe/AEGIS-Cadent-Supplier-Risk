import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  const appController = new AppController(new AppService());

  it('returns the service health payload', () => {
    expect(appController.getHealth()).toMatchObject({
      service: 'core-api',
      status: 'healthy',
    });
  });
});
