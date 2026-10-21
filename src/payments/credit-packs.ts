import { CreditPack } from '../generated/prisma/enums.js';

// Server-side source of truth for pricing -- never trust an amount/credit
// count from the client when creating an order. amountPaise is Razorpay's
// native smallest-unit (1 INR = 100 paise), same as what their Orders API
// expects directly.
export const CREDIT_PACKS: Record<CreditPack, { credits: number; amountPaise: number; label: string }> = {
  [CreditPack.STARTER]: { credits: 5, amountPaise: 9_900, label: 'Starter' },
  [CreditPack.JOB_SEARCH]: { credits: 15, amountPaise: 24_900, label: 'Job Search' },
  [CreditPack.INTENSIVE]: { credits: 35, amountPaise: 49_900, label: 'Intensive' },
};

export const CREDITS_EXPIRY_DAYS = 90;
