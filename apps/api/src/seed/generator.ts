import { randomUUID } from 'node:crypto';

/** mulberry32 — deterministic RNG so `pnpm seed` is reproducible */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  const v = arr[Math.floor(rng() * arr.length)];
  if (v === undefined) throw new Error('pick from empty array');
  return v;
}

export function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

const FIRST = ['Aarav', 'Priya', 'Rohan', 'Sneha', 'Vikram', 'Ananya', 'Karthik', 'Meera', 'Arjun', 'Divya', 'Rahul', 'Pooja', 'Siddharth', 'Neha', 'Aditya', 'Kavya', 'Manish', 'Ritu', 'Sanjay', 'Isha'];
const LAST = ['Sharma', 'Patel', 'Reddy', 'Iyer', 'Gupta', 'Singh', 'Nair', 'Joshi', 'Mehta', 'Rao', 'Verma', 'Kulkarni', 'Das', 'Chopra', 'Banerjee'];
const B2B = ['Trivedi Textiles', 'Nashik Agro Supplies', 'Kochi Marine Exports', 'Jaipur Handicrafts Co', 'Ludhiana Auto Parts', 'Surat Diamond Works', 'Indore Pharma Distributors', 'Guwahati Tea Traders', 'Pune Precision Tools', 'Vizag Steel Fabricators', 'Coimbatore Pumps Ltd', 'Kanpur Leather House', 'Bhopal Packaging', 'Madurai Textile Mills', 'Rajkot Ceramics'];
const PLANS = [
  { name: 'Starter Monthly', mrrPaise: 49_900 },
  { name: 'Growth Monthly', mrrPaise: 149_900 },
  { name: 'Pro Monthly', mrrPaise: 299_900 },
  { name: 'Scale Monthly', mrrPaise: 499_900 },
];

export interface SeedCustomerPlan {
  key: string;
  name: string;
  email: string;
  kind: 'b2c' | 'b2b';
  companyName?: string;
  language: 'en' | 'hi' | 'hinglish';
  scenario: Scenario;
  rail: 'card' | 'upi_autopay' | 'emandate' | 'netbanking';
  declineCode: string | null;
  amountPaise: number;
  plan?: { name: string; mrrPaise: number };
  /** for B2B aging */
  daysOverdue?: number;
  priorPaidInvoices?: number;
  /** scripted inbound reply after first outreach */
  scriptedReply?: string;
  /** failure timestamp override (month-end clustering) */
  failedAtDay?: number;
}

export type Scenario =
  | 'expired_card'
  | 'insufficient_funds_card'
  | 'insufficient_funds_upi'
  | 'ambiguous_decline'
  | 'processor_error'
  | 'b2b_overdue'
  | 'habitual_late_payer'
  | 'afa_high_value'
  | 'scripted_dispute'
  | 'scripted_optout';

export function generatePopulation(rng: () => number, total = 1000): SeedCustomerPlan[] {
  const plans: SeedCustomerPlan[] = [];
  const counts: Array<[Scenario, number]> = [
    ['expired_card', Math.round(total * 0.3)],
    ['insufficient_funds_card', Math.round(total * 0.15)],
    ['insufficient_funds_upi', Math.round(total * 0.1)],
    ['ambiguous_decline', Math.round(total * 0.06)],
    ['processor_error', Math.round(total * 0.04)],
    ['b2b_overdue', Math.round(total * 0.25)],
    ['habitual_late_payer', Math.round(total * 0.05)],
    ['afa_high_value', Math.max(1, Math.round(total * 0.008))],
    ['scripted_dispute', 1],
    ['scripted_optout', 1],
  ];
  const planned = counts.reduce((a, [, n]) => a + n, 0);
  counts.push(['b2b_overdue', Math.max(0, total - planned)]); // fill remainder

  let i = 0;
  for (const [scenario, n] of counts) {
    for (let k = 0; k < n; k++, i++) {
      plans.push(makeOne(rng, scenario, i));
    }
  }
  return plans;
}

function makeOne(rng: () => number, scenario: Scenario, i: number): SeedCustomerPlan {
  const isB2B = ['b2b_overdue', 'habitual_late_payer', 'afa_high_value'].includes(scenario);
  const person = `${pick(rng, FIRST)} ${pick(rng, LAST)}`;
  const company = pick(rng, B2B);
  const base: Omit<SeedCustomerPlan, 'scenario' | 'rail' | 'declineCode' | 'amountPaise'> = {
    key: `seed-${i}-${randomUUID().slice(0, 6)}`,
    name: isB2B ? company : person,
    email: `seed${i}@${isB2B ? 'b2b' : 'demo'}.reclaim.test`,
    kind: isB2B ? 'b2b' : 'b2c',
    ...(isB2B ? { companyName: company } : {}),
    language: pick(rng, ['en', 'en', 'en', 'hi', 'hinglish'] as const),
  };

  switch (scenario) {
    case 'expired_card': {
      const plan = pick(rng, PLANS);
      return { ...base, scenario, rail: 'card', declineCode: 'expired_card', amountPaise: plan.mrrPaise, plan };
    }
    case 'insufficient_funds_card': {
      const plan = pick(rng, PLANS);
      return {
        ...base, scenario, rail: 'card', declineCode: 'insufficient_funds', amountPaise: plan.mrrPaise, plan,
        failedAtDay: intBetween(rng, 26, 30), // clustered before month-end salary credits
      };
    }
    case 'insufficient_funds_upi': {
      const plan = pick(rng, PLANS);
      return {
        ...base, scenario, rail: 'upi_autopay', declineCode: 'upi_insufficient_balance', amountPaise: plan.mrrPaise, plan,
        failedAtDay: intBetween(rng, 26, 30),
      };
    }
    case 'ambiguous_decline': {
      const plan = pick(rng, PLANS);
      return { ...base, scenario, rail: 'card', declineCode: 'do_not_honor', amountPaise: plan.mrrPaise, plan };
    }
    case 'processor_error': {
      const plan = pick(rng, PLANS);
      return { ...base, scenario, rail: pick(rng, ['card', 'netbanking'] as const), declineCode: 'gateway_error', amountPaise: plan.mrrPaise, plan };
    }
    case 'b2b_overdue':
      return {
        ...base, scenario, rail: 'netbanking', declineCode: null,
        amountPaise: intBetween(rng, 800, 8000) * 1000, // ₹8,000–₹80,000
        daysOverdue: pick(rng, [15, 15, 35, 35, 35, 65, 65, 95, 130] as const),
      };
    case 'habitual_late_payer':
      return {
        ...base, scenario, rail: 'netbanking', declineCode: null,
        amountPaise: intBetween(rng, 500, 3000) * 1000,
        daysOverdue: pick(rng, [40, 70, 100] as const),
        priorPaidInvoices: 3,
      };
    case 'afa_high_value': {
      return {
        ...base, scenario, rail: 'emandate', declineCode: 'insufficient_funds',
        amountPaise: intBetween(rng, 1600, 4500) * 1000, // above ₹15,000 AFA line
        plan: { name: 'Enterprise Annual', mrrPaise: intBetween(rng, 1600, 4500) * 1000 },
      };
    }
    case 'scripted_dispute': {
      const plan = PLANS[2]!;
      return {
        ...base, name: 'Deepak Dispute', email: 'deepak.dispute@demo.reclaim.test',
        scenario, rail: 'card', declineCode: 'do_not_honor', amountPaise: plan.mrrPaise, plan,
        scriptedReply: 'I dispute this charge. It was not authorized by me and I have raised a chargeback with my bank.',
      };
    }
    case 'scripted_optout': {
      const plan = PLANS[1]!;
      return {
        ...base, name: 'Omkar Optout', email: 'omkar.optout@demo.reclaim.test',
        scenario, rail: 'card', declineCode: 'insufficient_funds', amountPaise: plan.mrrPaise, plan,
        scriptedReply: 'STOP. Unsubscribe me from all payment emails immediately.',
      };
    }
  }
}
