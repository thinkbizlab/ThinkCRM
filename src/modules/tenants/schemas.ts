import { z } from "zod";

export const onboardTenantSchema = z.object({
  companyName: z.string().min(2).max(120),
  companySlug: z
    .string()
    .min(2)
    .max(60)
    .regex(/^[a-z0-9-]+$/, "companySlug must be lowercase letters, numbers, and hyphens"),
  admin: z.object({
    email: z.string().email(),
    fullName: z.string().min(2).max(120)
  }),
  billing: z.object({
    seatPriceCents: z.number().int().positive(),
    initialSeatCount: z.number().int().positive().default(1),
    currency: z.string().length(3).default("THB"),
    paymentMethodRef: z.string().min(3),
    overagePricePerGb: z.number().int().nonnegative().default(0),
    includedBytes: z.number().int().positive().default(1_073_741_824)
  })
});

export type OnboardTenantInput = z.infer<typeof onboardTenantSchema>;
