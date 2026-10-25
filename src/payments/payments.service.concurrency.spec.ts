import 'dotenv/config';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID, createHmac } from 'node:crypto';
import { PaymentsService } from './payments.service.js';
import { CreditPack, PurchaseStatus } from '../generated/prisma/enums.js';
import { CREDIT_PACKS } from './credit-packs.js';
import { createTestPrismaService, createTestUser } from '../test-helpers/db.js';

// This suite exists because of a real incident risk the code comments in
// payments.service.ts call out directly: a webhook delivered twice (a
// genuine Razorpay retry, or two instances racing) must credit the
// account exactly once, never zero and never twice. handleWebhook's
// guard is a single atomic `updateMany WHERE status = PENDING` -- these
// tests prove that guard actually holds against real concurrent
// transactions on real Postgres, not just that the code reads correctly.
const WEBHOOK_SECRET = 'test-webhook-secret-for-concurrency-spec';

function signPayload(body: string): string {
  return createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
}

function buildCapturedEventBody(orderId: string, paymentId: string): string {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: { entity: { id: paymentId, order_id: orderId, amount: 9900, status: 'captured' } },
    },
  });
}

describe('PaymentsService.handleWebhook concurrency/idempotency', () => {
  const prisma = createTestPrismaService();
  const originalSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  beforeAll(async () => {
    await prisma.$connect();
    process.env.RAZORPAY_WEBHOOK_SECRET = WEBHOOK_SECRET;
  });

  afterAll(async () => {
    process.env.RAZORPAY_WEBHOOK_SECRET = originalSecret;
    await prisma.$disconnect();
  });

  async function setupPendingPurchase() {
    const user = await createTestUser(prisma, { creditsBalance: 0 });
    const orderId = `order_test_${randomUUID()}`;
    const pack = CREDIT_PACKS[CreditPack.STARTER];
    await prisma.creditPurchase.create({
      data: {
        userId: user.id,
        pack: CreditPack.STARTER,
        credits: pack.credits,
        amountPaise: pack.amountPaise,
        razorpayOrderId: orderId,
      },
    });
    return { user, orderId, pack };
  }

  it('credits the account exactly once when the same event is delivered twice sequentially (retry)', async () => {
    const { user, orderId, pack } = await setupPendingPurchase();
    const paymentId = `pay_test_${randomUUID()}`;
    const service = new PaymentsService(prisma);
    const body = Buffer.from(buildCapturedEventBody(orderId, paymentId));
    const signature = signPayload(body.toString());

    await service.handleWebhook(body, signature);
    await service.handleWebhook(body, signature);

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(pack.credits);

    const purchase = await prisma.creditPurchase.findUniqueOrThrow({ where: { razorpayOrderId: orderId } });
    expect(purchase.status).toBe(PurchaseStatus.PAID);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('credits the account exactly once under truly concurrent deliveries of the same event', async () => {
    const { user, orderId, pack } = await setupPendingPurchase();
    const paymentId = `pay_test_${randomUUID()}`;
    const service = new PaymentsService(prisma);
    const body = Buffer.from(buildCapturedEventBody(orderId, paymentId));
    const signature = signPayload(body.toString());

    const CONCURRENCY = 8;
    await Promise.all(Array.from({ length: CONCURRENCY }, () => service.handleWebhook(body, signature)));

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.creditsBalance).toBe(pack.credits);

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('is a no-op for an unknown order id (not a crash, not a credit grant)', async () => {
    const service = new PaymentsService(prisma);
    const body = Buffer.from(buildCapturedEventBody('order_does_not_exist', `pay_test_${randomUUID()}`));
    const signature = signPayload(body.toString());

    await expect(service.handleWebhook(body, signature)).resolves.toBeUndefined();
  });

  it('rejects a payload with an invalid signature', async () => {
    const service = new PaymentsService(prisma);
    const body = Buffer.from(buildCapturedEventBody('order_whatever', 'pay_whatever'));

    await expect(service.handleWebhook(body, 'not-the-real-signature')).rejects.toThrow();
  });
});
