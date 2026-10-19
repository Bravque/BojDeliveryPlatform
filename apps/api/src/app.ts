import { randomUUID } from 'node:crypto';
import express, { type Express } from 'express';
import pinoHttp from 'pino-http';
import { errorHandler, notFoundHandler } from './middleware/error';
import type { Logger } from './platform/logger';
import { merchantAdminRouter, type MerchantModule } from './routes/admin-merchants';
import { adminRouter } from './routes/admin';
import { authRouter, type AuthModule } from './routes/auth';
import { browseRouter, type BrowseModule } from './routes/browse';
import { cartRouter, type CartModule } from './routes/cart';
import { adminFeeRulesRouter, type FeesModule } from './routes/fees';
import { addressesRouter, adminZonesRouter, type GeoModule } from './routes/geo';
import { healthRouter, type HealthDeps } from './routes/health';
import { merchantRouter } from './routes/merchant';
import { ordersRouter, type OrdersModule } from './routes/orders';
import { adminPromotionsRouter, type PromotionsModule } from './routes/promotions';
import { quoteRouter, type PricingModule } from './routes/quote';

export interface AppDeps {
  logger: Logger;
  version: string;
  checkReadiness?: HealthDeps['checkReadiness'];
  /** When provided, mounts the `/api/v1` auth endpoints. */
  auth?: AuthModule;
  /** When provided, mounts the `/api/v1` merchant endpoints. */
  merchant?: MerchantModule;
  /** When provided, mounts the public `/api/v1` catalogue-browse endpoints (no auth). */
  browse?: BrowseModule;
  /** When provided, mounts the `/api/v1` zone-admin + customer-address endpoints. */
  geo?: GeoModule;
  /** When provided, mounts the `/api/v1` admin delivery-fee-rule endpoints. */
  fees?: FeesModule;
  /** When provided, mounts the `/api/v1` customer cart endpoints. */
  cart?: CartModule;
  /** When provided, mounts the `/api/v1` admin promotion endpoints. */
  promotions?: PromotionsModule;
  /** When provided, mounts the `/api/v1/cart/quote` endpoint. */
  pricing?: PricingModule;
  /** When provided, mounts the `/api/v1/orders` endpoints. */
  orders?: OrdersModule;
}

/** Build the Express application. Pure factory — no network/DB side effects. */
export function createApp(deps: AppDeps): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.use(
    pinoHttp({
      logger: deps.logger,
      genReqId: (req, res) => {
        const headerId = req.headers['x-request-id'];
        const id = typeof headerId === 'string' && headerId.length > 0 ? headerId : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
    }),
  );

  app.use(healthRouter({ version: deps.version, checkReadiness: deps.checkReadiness }));

  if (
    deps.auth ||
    deps.merchant ||
    deps.browse ||
    deps.geo ||
    deps.fees ||
    deps.cart ||
    deps.promotions ||
    deps.pricing ||
    deps.orders
  ) {
    const apiV1 = express.Router();
    if (deps.auth) {
      apiV1.use(authRouter(deps.auth));
      apiV1.use(adminRouter(deps.auth.requireAuth, deps.auth.auditService));
    }
    if (deps.merchant) {
      apiV1.use(merchantAdminRouter(deps.merchant.merchantService, deps.merchant.requireAuth));
      apiV1.use(merchantRouter(deps.merchant.catalogueService, deps.merchant.requireAuth));
    }
    if (deps.browse) {
      apiV1.use(browseRouter(deps.browse.browseService));
    }
    if (deps.geo) {
      apiV1.use(adminZonesRouter(deps.geo.zoneService, deps.geo.requireAuth));
      apiV1.use(addressesRouter(deps.geo.addressService, deps.geo.requireAuth));
    }
    if (deps.fees) {
      apiV1.use(adminFeeRulesRouter(deps.fees.feeService, deps.fees.requireAuth));
    }
    if (deps.cart) {
      apiV1.use(cartRouter(deps.cart.cartService, deps.cart.requireAuth));
    }
    if (deps.promotions) {
      apiV1.use(
        adminPromotionsRouter(deps.promotions.promotionService, deps.promotions.requireAuth),
      );
    }
    if (deps.pricing) {
      apiV1.use(quoteRouter(deps.pricing.quoteService, deps.pricing.requireAuth));
    }
    if (deps.orders) {
      apiV1.use(ordersRouter(deps.orders.orderService, deps.orders.requireAuth));
    }
    app.use('/api/v1', apiV1);
  }

  // Unmatched routes -> 404, then the centralized error handler (must be mounted last).
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
