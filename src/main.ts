import type { IncomingMessage } from 'node:http';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  // bodyParser: false, then apply express.json() manually with a verify
  // callback -- Razorpay webhook signature verification needs the EXACT
  // raw bytes that were signed, and re-serializing an already-parsed JSON
  // object isn't guaranteed byte-identical to what was actually sent. This
  // stashes the raw buffer on req.rawBody for every request (used only by
  // the webhook route); every other route still gets normally-parsed
  // req.body exactly as before.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(
    json({
      verify: (req: IncomingMessage & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3001',
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true }),
  );

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
