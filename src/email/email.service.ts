import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class EmailService {
  private client: Resend | null = null;

  constructor(private readonly configService: ConfigService) {}

  // Lazy, not constructed in the constructor -- RESEND_API_KEY isn't set
  // yet in every environment this runs in, and failing eagerly here would
  // crash the entire app at boot over one unrelated feature. Only the
  // email-sending call site fails until the key is actually configured.
  private getClient(): Resend {
    if (!this.client) {
      const apiKey = this.configService.get<string>('RESEND_API_KEY');
      if (!apiKey) {
        throw new Error('RESEND_API_KEY is not configured');
      }
      this.client = new Resend(apiKey);
    }
    return this.client;
  }

  private get fromAddress(): string {
    return (
      this.configService.get<string>('RESEND_FROM_EMAIL') ??
      'Cease to Resume <noreply@ceasetoresume.online>'
    );
  }

  async sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
    await this.getClient().emails.send({
      from: this.fromAddress,
      to,
      subject: 'Reset your Cease to Resume password',
      html: `
        <p>Someone requested a password reset for this account. Click the link below to choose a new password -- this link expires in 1 hour.</p>
        <p><a href="${resetUrl}">${resetUrl}</a></p>
        <p>If you didn't request this, you can safely ignore this email -- your password hasn't been changed.</p>
      `,
    });
  }

  async sendVerificationEmail(to: string, code: string): Promise<void> {
    await this.getClient().emails.send({
      from: this.fromAddress,
      to,
      subject: `${code} is your Cease to Resume verification code`,
      html: `
        <p>Enter this code to verify your email and finish setting up your account. It expires in 10 minutes.</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">${code}</p>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });
  }
}
