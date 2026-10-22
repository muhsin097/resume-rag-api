import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import Razorpay from 'razorpay';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreditPack, PurchaseStatus } from '../generated/prisma/enums.js';
import { CREDIT_PACKS, CREDITS_EXPIRY_DAYS } from './credit-packs.js';

interface RazorpayPaymentCapturedEvent {
  event: string;
  payload: {
    payment: {
      entity: {
        id: string;
        order_id: string;
        amount: number;
        status: string;
      };
    };
  };
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private client: Razorpay | null = null;

  constructor(private readonly prisma: PrismaService) {}

  // Lazy, same reasoning as EmailService's Resend client -- a missing key
  // shouldn't crash the whole app at boot over one feature, only fail the
  // specific call site that actually needs it.
  private getClient(): Razorpay {
    if (!this.client) {
      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (!keyId || !keySecret) {
        throw new Error('RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET are not configured');
      }
      this.client = new Razorpay({ key_id: keyId, key_secret: keySecret });
    }
    return this.client;
  }

  // Server-side order creation, never trusting a price from the client --
  // the pack name is all the frontend sends; the amount/credits come from
  // CREDIT_PACKS here. A PENDING CreditPurchase row is created up front
  // (before any payment has happened) so there's always something for the
  // webhook to reconcile against, keyed by the Razorpay order id.
  async createOrder(userId: string, pack: CreditPack) {
    const packConfig = CREDIT_PACKS[pack];
    if (!packConfig) {
      throw new BadRequestException(`Unknown credit pack: ${pack}`);
    }

    const order = await this.getClient().orders.create({
      amount: packConfig.amountPaise,
      currency: 'INR',
      // notes are the authoritative link back to our own records if we
      // ever need to reconcile by hand from the Razorpay dashboard --
      // the webhook itself looks the purchase up by order id, not notes.
      notes: { userId, pack },
    });

    await this.prisma.creditPurchase.create({
      data: {
        userId,
        pack,
        credits: packConfig.credits,
        amountPaise: packConfig.amountPaise,
        razorpayOrderId: order.id,
      },
    });

    return {
      orderId: order.id,
      amount: packConfig.amountPaise,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      pack,
      credits: packConfig.credits,
    };
  }

  // Polled by the frontend after Razorpay's own client-side success
  // callback fires, so "purchase complete" in the UI reflects the webhook
  // actually having landed and credited the account -- not just a blind
  // timeout guess that it probably did by now. Scoped to the requesting
  // user's own orders (WHERE userId) so one account can't probe another's
  // purchase status by guessing order ids.
  async getOrderStatus(userId: string, orderId: string) {
    const purchase = await this.prisma.creditPurchase.findFirst({
      where: { razorpayOrderId: orderId, userId },
      select: { status: true, credits: true },
    });
    if (!purchase) {
      throw new BadRequestException('Unknown order.');
    }
    return purchase;
  }

  // rawBody must be the exact bytes Razorpay signed (see main.ts's
  // express.json verify callback) -- re-serializing an already-parsed
  // object is not guaranteed byte-identical and would make every
  // signature check fail unpredictably.
  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET is not configured');
    }
    if (!signature) {
      throw new UnauthorizedException('Missing Razorpay webhook signature');
    }

    const valid = Razorpay.validateWebhookSignature(rawBody.toString(), signature, webhookSecret);
    if (!valid) {
      throw new UnauthorizedException('Invalid Razorpay webhook signature');
    }

    const event = JSON.parse(rawBody.toString()) as RazorpayPaymentCapturedEvent;
    if (event.event !== 'payment.captured') {
      // Plenty of other event types (order.paid, payment.failed, etc.)
      // can hit this endpoint depending on which events the webhook is
      // subscribed to in the Razorpay dashboard -- only payment.captured
      // actually grants credits; anything else is a deliberate no-op,
      // not an error.
      return;
    }

    const { order_id: orderId, id: paymentId } = event.payload.payment.entity;

    const expiresAt = new Date(Date.now() + CREDITS_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    // Atomic AND idempotent, now in one DB transaction: previously the
    // PENDING->PAID flip and the credit increment were two separate
    // awaits, so a crash (process restart, dropped DB connection) between
    // them left a purchase permanently stuck PAID with zero credits
    // granted -- and Razorpay's retry would then find status: PAID and
    // silently skip it forever, since the idempotency check only looks
    // for PENDING. Wrapping both in $transaction means either the whole
    // grant lands, or Postgres rolls it back to PENDING so the next
    // webhook retry can actually succeed.
    const credited = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.creditPurchase.updateMany({
        where: { razorpayOrderId: orderId, status: PurchaseStatus.PENDING },
        data: { status: PurchaseStatus.PAID, razorpayPaymentId: paymentId, paidAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const purchase = await tx.creditPurchase.findUniqueOrThrow({
        where: { razorpayOrderId: orderId },
      });

      await tx.user.update({
        where: { id: purchase.userId },
        data: {
          creditsBalance: { increment: purchase.credits },
          // Overwritten, not extended -- one combined balance/expiry rather
          // than FIFO-expiring batches (see the schema comment on
          // creditsExpireAt for the reasoning).
          creditsExpireAt: expiresAt,
        },
      });

      return purchase;
    });

    if (!credited) {
      this.logger.log(`Webhook for order ${orderId} ignored -- already processed or unknown order`);
      return;
    }

    this.logger.log(
      `Credited ${credited.credits} generations to user ${credited.userId} (order ${orderId}, payment ${paymentId})`,
    );
  }
}
