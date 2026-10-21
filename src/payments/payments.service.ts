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

    // Atomic, idempotent: only the delivery that actually flips PENDING ->
    // PAID proceeds to credit the account. Razorpay can and does retry
    // webhook delivery (and can occasionally double-deliver even without a
    // failure) -- a second delivery for the same payment finds count:0
    // here and returns without crediting twice.
    const claimed = await this.prisma.creditPurchase.updateMany({
      where: { razorpayOrderId: orderId, status: PurchaseStatus.PENDING },
      data: { status: PurchaseStatus.PAID, razorpayPaymentId: paymentId, paidAt: new Date() },
    });
    if (claimed.count === 0) {
      this.logger.log(`Webhook for order ${orderId} ignored -- already processed or unknown order`);
      return;
    }

    const purchase = await this.prisma.creditPurchase.findUniqueOrThrow({
      where: { razorpayOrderId: orderId },
    });

    const expiresAt = new Date(Date.now() + CREDITS_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
    await this.prisma.user.update({
      where: { id: purchase.userId },
      data: {
        creditsBalance: { increment: purchase.credits },
        // Overwritten, not extended -- one combined balance/expiry rather
        // than FIFO-expiring batches (see the schema comment on
        // creditsExpireAt for the reasoning).
        creditsExpireAt: expiresAt,
      },
    });

    this.logger.log(
      `Credited ${purchase.credits} generations to user ${purchase.userId} (order ${orderId}, payment ${paymentId})`,
    );
  }
}
