import { Body, Controller, Get, Headers, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard.js';
import { CurrentUser } from '../auth/decorators/current-user.decorator.js';
import type { AuthenticatedUser } from '../auth/decorators/current-user.decorator.js';
import { PaymentsService } from './payments.service.js';
import { CreateOrderDto } from './dto/create-order.dto.js';

// rawBody is stashed on the request by main.ts's express.json verify
// callback -- not part of Express's own Request type, extended here just
// for this one controller's use.
interface RequestWithRawBody extends Request {
  rawBody?: Buffer;
}

@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @UseGuards(JwtAuthGuard)
  @Post('create-order')
  async createOrder(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateOrderDto) {
    return this.paymentsService.createOrder(user.id, dto.pack);
  }

  @UseGuards(JwtAuthGuard)
  @Get('orders/:orderId')
  async getOrderStatus(@CurrentUser() user: AuthenticatedUser, @Param('orderId') orderId: string) {
    return this.paymentsService.getOrderStatus(user.id, orderId);
  }

  // Deliberately NOT behind JwtAuthGuard -- Razorpay's own servers call
  // this directly, with no user session. Authenticity is established by
  // the HMAC signature check inside handleWebhook, not a bearer token.
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: RequestWithRawBody,
    @Headers('x-razorpay-signature') signature: string | undefined,
  ) {
    // Razorpay expects a 200 regardless of whether this event type needed
    // action, to stop retrying -- only an actually-invalid signature (a
    // real auth failure, handled inside the service) should return
    // non-200 and trigger their retry behavior.
    await this.paymentsService.handleWebhook(req.rawBody ?? Buffer.from(''), signature);
    return { received: true };
  }
}
