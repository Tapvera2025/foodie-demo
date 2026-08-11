import { Module } from '@nestjs/common';
import { DatabaseModule } from './platform/database.module.js';
import { HealthController } from './health/health.controller.js';

/**
 * Root module.
 *
 * Feature modules are added here as they land, in the order given by TDD §2.1.
 * The dependency direction between them is enforced by eslint-plugin-boundaries
 * (see eslint.config.js), not by convention.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [],
})
export class AppModule {}
