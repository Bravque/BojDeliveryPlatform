import { createServer } from 'node:http';
import { createAddressService } from './addresses/address-service';
import { createKnexAddressRepo } from './addresses/repo';
import { createAuditService } from './auth/audit-service';
import { loadAuthConfig } from './auth/config';
import { createCartService } from './cart/cart-service';
import { createKnexCartRepo } from './cart/repo';
import { createOtpService } from './auth/otp-service';
import { createPasswordService } from './auth/password-service';
import { createKnexAuthRepo } from './auth/repo';
import { createSessionService } from './auth/session-service';
import { MockSmsProvider } from './auth/sms/mock';
import { createUserService } from './auth/user-service';
import { createApp } from './app';
import { createKnexBrowseRepo } from './browse/repo';
import { createBrowseService } from './browse/service';
import { createCatalogueService } from './catalogue/catalogue-service';
import { createKnexCatalogueRepo } from './catalogue/repo';
import { createFeeService } from './fees/fee-service';
import { createKnexDeliveryFeeRuleRepo } from './fees/repo';
import { createLedgerService } from './ledger/ledger-service';
import { createKnexLedgerRepo } from './ledger/repo';
import { createMerchantService } from './merchant/merchant-service';
import { createKnexMerchantRepo } from './merchant/repo';
import { createRequireAuth } from './middleware/auth';
import { createAssignmentService } from './delivery/assignment-service';
import { createDeliveryService } from './delivery/delivery-service';
import { createKnexDeliveryRepo } from './delivery/repo';
import { createFulfillmentService } from './orders/fulfillment-service';
import { createOrderService } from './orders/order-service';
import { createKnexOrdersRepo } from './orders/repo';
import { createCaptureService } from './payments/capture-service';
import type { PaymentGateway } from './payments/gateway';
import { createPaymentService } from './payments/payment-service';
import { createReconcileService } from './payments/reconcile-service';
import { createRefundService } from './payments/refund-service';
import { createKnexPaymentsRepo, type PaymentMethod } from './payments/repo';
import { SimulatedGateway } from './payments/simulated-gateway';
import { createDarajaClient } from './payments/daraja/client';
import { DarajaGateway } from './payments/daraja/daraja-gateway';
import { createKnexPricingRepo } from './pricing/repo';
import { createQuoteService } from './pricing/quote-service';
import { createKnexPromotionRepo } from './promotions/repo';
import { createPromotionService } from './promotions/promotion-service';
import { createSettlementService } from './settlements/settlement-service';
import { createKnexSettlementsRepo } from './settlements/repo';
import { createPayoutService } from './payouts/payout-service';
import { createKnexPayoutsRepo } from './payouts/repo';
import { SimulatedPayoutGateway } from './payouts/gateway';
import { createReportService } from './reports/report-service';
import { createKnexReportsRepo } from './reports/repo';
import { createPresenceService } from './riders/presence-service';
import { createRiderService } from './riders/rider-service';
import { createKnexRiderRepo } from './riders/repo';
import { createKnexZoneRepo } from './zones/repo';
import { createZoneService } from './zones/zone-service';
import { loadEnv } from './env';
import { buildKnexConfig, checkDbHealth, createDb } from './platform/db';
import { createLogger } from './platform/logger';
import { combinePublishers, createRealtimeEventPublisher } from './platform/events/publisher';
import { createDeviceService } from './notifications/device-service';
import { createNotificationDispatcher } from './notifications/dispatcher';
import { MockPushProvider } from './notifications/mock-push';
import { createKnexNotificationsRepo } from './notifications/repo';
import { createLateBoundGateway } from './platform/realtime/gateway';
import { createKnexRealtimeResolver } from './platform/realtime/resolver';
import { createRealtimeServer } from './platform/realtime/server';

const VERSION = process.env.npm_package_version ?? '0.0.0';

function main(): void {
  const env = loadEnv(); // fail-fast on missing/invalid configuration
  const authConfig = loadAuthConfig(); // fail-fast on missing JWT keys / OTP pepper
  const logger = createLogger({ level: env.LOG_LEVEL });
  const db = createDb(buildKnexConfig({ DATABASE_URL: env.DATABASE_URL }));

  // Phase 1 uses the mock SMS provider; it logs the OTP body only outside production (D12).
  const repo = createKnexAuthRepo(db);
  const sms = new MockSmsProvider({ logger, logBody: env.NODE_ENV !== 'production' });
  const auth = {
    otpService: createOtpService({ repo, sms, config: authConfig }),
    passwordService: createPasswordService({ repo, config: authConfig }),
    sessionService: createSessionService({ repo, config: authConfig }),
    userService: createUserService({ repo }),
    auditService: createAuditService(repo),
    requireAuth: createRequireAuth({
      publicKey: authConfig.JWT_PUBLIC_KEY,
      issuer: authConfig.JWT_ISSUER,
      audience: authConfig.JWT_AUDIENCE,
    }),
  };

  const merchant = {
    merchantService: createMerchantService({
      repo: createKnexMerchantRepo(db),
      auditService: auth.auditService,
    }),
    catalogueService: createCatalogueService({ repo: createKnexCatalogueRepo(db) }),
    requireAuth: auth.requireAuth,
  };

  const browse = {
    browseService: createBrowseService({ repo: createKnexBrowseRepo(db) }),
  };

  const zoneService = createZoneService({
    repo: createKnexZoneRepo(db),
    auditService: auth.auditService,
  });
  const geo = {
    zoneService,
    addressService: createAddressService({ repo: createKnexAddressRepo(db), zoneService }),
    requireAuth: auth.requireAuth,
  };

  const fees = {
    feeService: createFeeService({
      repo: createKnexDeliveryFeeRuleRepo(db),
      auditService: auth.auditService,
    }),
    requireAuth: auth.requireAuth,
  };

  const cart = {
    cartService: createCartService({ repo: createKnexCartRepo(db) }),
    requireAuth: auth.requireAuth,
  };

  const promotionService = createPromotionService({
    repo: createKnexPromotionRepo(db),
    auditService: auth.auditService,
  });
  const promotions = { promotionService, requireAuth: auth.requireAuth };

  const pricing = {
    quoteService: createQuoteService({
      repo: createKnexPricingRepo(db),
      zones: zoneService,
      fees: fees.feeService,
      promotions: promotionService,
    }),
    requireAuth: auth.requireAuth,
  };

  const ledgerService = createLedgerService();

  // Realtime: the gateway is bound after the Socket.IO server is created (which needs the built
  // app); services take the late-bound gateway now via the event publisher (best-effort emits).
  const realtimeResolver = createKnexRealtimeResolver(db);
  const lateGateway = createLateBoundGateway();
  const notificationsRepo = createKnexNotificationsRepo(db);
  const notificationDispatcher = createNotificationDispatcher({
    repo: notificationsRepo,
    push: new MockPushProvider({ logger, logBody: env.NODE_ENV !== 'production' }),
    sms,
    logger,
  });
  // Domain events fan out to both realtime (sockets) and notifications (push/SMS), best-effort.
  const events = combinePublishers(
    createRealtimeEventPublisher({
      gateway: lateGateway.gateway,
      resolver: realtimeResolver,
      logger,
    }),
    notificationDispatcher,
  );
  const notifications = {
    deviceService: createDeviceService({ repo: notificationsRepo }),
    requireAuth: auth.requireAuth,
  };

  const settlements = {
    settlementService: createSettlementService({
      withTransaction: (work) => db.transaction((trx) => work(createKnexSettlementsRepo(trx))),
      auditService: auth.auditService,
    }),
    requireAuth: auth.requireAuth,
  };

  const payouts = {
    payoutService: createPayoutService({
      withTransaction: (work) =>
        db.transaction((trx) =>
          work({ payouts: createKnexPayoutsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
        ),
      ledgerService,
      gateway: new SimulatedPayoutGateway(),
      auditService: auth.auditService,
    }),
    requireAuth: auth.requireAuth,
    allowDevSimulate: env.NODE_ENV !== 'production',
  };

  const reports = {
    reportService: createReportService({
      reportsRepo: createKnexReportsRepo(db),
      ledgerReadRepo: createKnexLedgerRepo(db),
    }),
    requireAuth: auth.requireAuth,
  };

  const assignmentService = createAssignmentService({
    readRepo: createKnexDeliveryRepo(db),
    withTransaction: (work) =>
      db.transaction((trx) =>
        work({ delivery: createKnexDeliveryRepo(trx), orders: createKnexOrdersRepo(trx) }),
      ),
    config: {
      maxRadiusM: env.RIDER_MAX_RADIUS_M,
      offerTtlSec: env.RIDER_OFFER_TTL_SEC,
      presenceFreshnessSec: env.RIDER_PRESENCE_FRESHNESS_SEC,
      riderFeeFlatCents: env.RIDER_FEE_FLAT_CENTS,
    },
    events,
  });
  const deliveryService = createDeliveryService({
    readRepo: createKnexDeliveryRepo(db),
    withTransaction: (work) =>
      db.transaction((trx) =>
        work({
          delivery: createKnexDeliveryRepo(trx),
          orders: createKnexOrdersRepo(trx),
          ledger: createKnexLedgerRepo(trx),
        }),
      ),
    ledgerService,
    auditService: auth.auditService,
    config: {
      pinTtlSec: env.DELIVERY_PIN_TTL_SEC,
      pinMaxAttempts: env.DELIVERY_PIN_MAX_ATTEMPTS,
    },
    events,
  });
  const delivery = { assignmentService, deliveryService, requireAuth: auth.requireAuth };

  const orders = {
    orderService: createOrderService({
      readRepo: createKnexOrdersRepo(db),
      withTransaction: (work) => db.transaction((trx) => work(createKnexOrdersRepo(trx))),
      zones: zoneService,
      fees: fees.feeService,
    }),
    fulfillmentService: createFulfillmentService({
      withTransaction: (work) => db.transaction((trx) => work(createKnexOrdersRepo(trx))),
      // When an order is marked ready, offer it to a rider (best-effort; the tick re-offers).
      onReadyForPickup: async (orderUlid) => {
        await assignmentService.offerForOrder(orderUlid);
      },
      events,
    }),
    requireAuth: auth.requireAuth,
  };

  // Simulated locally/CI; a Daraja value swaps in the real STK adapter (doc 07 §2). Daraja creds are
  // validated as required by loadEnv when a Daraja provider is selected, so the `!` are safe here.
  const buildGateway = (): { gateway: PaymentGateway; method: PaymentMethod } => {
    if (env.PAYMENT_PROVIDER === 'simulated') {
      return { gateway: new SimulatedGateway(), method: 'simulated' };
    }
    const client = createDarajaClient({
      baseUrl: env.DARAJA_BASE_URL!,
      consumerKey: env.DARAJA_CONSUMER_KEY!,
      consumerSecret: env.DARAJA_CONSUMER_SECRET!,
    });
    const gateway = new DarajaGateway({
      client,
      shortcode: env.DARAJA_SHORTCODE!,
      passkey: env.DARAJA_PASSKEY!,
      callbackUrl: env.DARAJA_CALLBACK_URL!,
    });
    return { gateway, method: 'mpesa_stk' };
  };
  const { gateway, method: paymentMethod } = buildGateway();
  const webhookIpAllowlist = env.DARAJA_WEBHOOK_IP_ALLOWLIST?.split(',')
    .map((ip) => ip.trim())
    .filter(Boolean);
  const captureService = createCaptureService({
    readRepo: createKnexPaymentsRepo(db),
    withTransaction: (work) =>
      db.transaction((trx) =>
        work({ payments: createKnexPaymentsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
      ),
    ledgerService,
    events,
  });
  const payments = {
    paymentService: createPaymentService({
      readRepo: createKnexPaymentsRepo(db),
      withTransaction: (work) => db.transaction((trx) => work(createKnexPaymentsRepo(trx))),
      gateway,
      method: paymentMethod,
    }),
    captureService,
    reconcileService: createReconcileService({
      readRepo: createKnexPaymentsRepo(db),
      gateway,
      captureService,
      ledgerReadRepo: createKnexLedgerRepo(db),
    }),
    refundService: createRefundService({
      readRepo: createKnexPaymentsRepo(db),
      withTransaction: (work) =>
        db.transaction((trx) =>
          work({ payments: createKnexPaymentsRepo(trx), ledger: createKnexLedgerRepo(trx) }),
        ),
      ledgerService,
      gateway,
    }),
    requireAuth: auth.requireAuth,
    webhookToken: env.MPESA_WEBHOOK_TOKEN,
    webhookIpAllowlist,
    allowDevSimulate: env.NODE_ENV !== 'production',
  };

  const riders = {
    riderService: createRiderService({
      repo: createKnexRiderRepo(db),
      auditService: auth.auditService,
    }),
    presenceService: createPresenceService({
      repo: createKnexRiderRepo(db),
      pingMinIntervalSec: env.RIDER_PING_MIN_INTERVAL_SEC,
    }),
    requireAuth: auth.requireAuth,
  };

  const app = createApp({
    logger,
    version: VERSION,
    checkReadiness: async () => ({ db: await checkDbHealth(db) }),
    auth,
    merchant,
    browse,
    geo,
    fees,
    cart,
    promotions,
    pricing,
    orders,
    payments,
    riders,
    delivery,
    notifications,
    settlements,
    payouts,
    reports,
    security: {
      corsAllowedOrigins: env.CORS_ALLOWED_ORIGINS?.split(',')
        .map((o) => o.trim())
        .filter(Boolean),
      trustProxy: env.TRUST_PROXY,
      rateLimit: { windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000, limit: env.RATE_LIMIT_MAX },
      authRateLimit: { windowMs: env.RATE_LIMIT_WINDOW_SEC * 1000, limit: env.AUTH_RATE_LIMIT_MAX },
    },
  });

  const httpServer = createServer(app);
  const realtime = createRealtimeServer(httpServer, {
    verifyOpts: {
      publicKey: authConfig.JWT_PUBLIC_KEY,
      issuer: authConfig.JWT_ISSUER,
      audience: authConfig.JWT_AUDIENCE,
    },
    resolver: realtimeResolver,
    logger,
  });
  lateGateway.bind(realtime.gateway); // domain events now reach live sockets
  const server = httpServer.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening (HTTP + realtime)');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      void db.destroy().finally(() => process.exit(0));
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
