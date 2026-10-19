import { z } from 'zod';
import type { SkillDraft } from './domain';

export const MAX_SKILL_DRAFT_BYTES = 64 * 1024;

const shortText = z.string().trim().min(1).max(255);
const prose = z.string().trim().min(1).max(4_000);
const boundedJson = z.json().refine(
  (value) => JSON.stringify(value).length <= 8_192,
  'JSON value exceeds 8192 characters',
);
const pattern = z.string().trim().min(1).max(500).refine((value) => {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}, 'Invalid regular expression');

const ioFieldSchema = z.object({
  name: shortText,
  description: z.string().trim().max(1_000),
  required: z.boolean(),
  schema: boundedJson.optional(),
}).strict();

const skillBodySchema = z.object({
  purpose: prose,
  applicability: prose,
  requiredContext: z.array(shortText).min(1).max(32),
  inputContract: z.array(ioFieldSchema).min(1).max(32),
  outputContract: z.array(ioFieldSchema).min(1).max(32),
  steps: z.array(z.object({
    instruction: prose,
    constraints: z.array(prose).max(16),
  }).strict()).min(1).max(32),
  toolRequirements: z.array(shortText).min(1).max(32),
  failureHandling: prose,
  verificationCriteria: z.array(prose).min(1).max(32),
  examples: z.array(z.object({
    title: shortText,
    input: boundedJson,
    expectedOutput: boundedJson,
  }).strict()).min(1).max(10),
}).strict();

const templateFieldSchema = z.object({
  name: shortText,
  labels: z.array(shortText).min(1).max(16),
  required: z.boolean(),
  normalization: z.enum(['text', 'identifier', 'amount', 'date']),
  pattern: pattern.optional(),
}).strict();

const lineItemColumnSchema = z.object({
  field: z.enum(['sku', 'description', 'quantity', 'unitPrice', 'amount']),
  labels: z.array(shortText).min(1).max(16),
  required: z.boolean(),
}).strict();

export const InvoiceExtractionTemplateSchema = z.object({
  fields: z.array(templateFieldSchema).min(1).max(64),
  lineItems: z.object({
    columns: z.array(lineItemColumnSchema).min(1).max(5),
    rowPattern: pattern.optional(),
  }).strict().optional(),
}).strict().superRefine((template, context) => {
  const fieldNames = new Set<string>();
  template.fields.forEach((field, index) => {
    if (fieldNames.has(field.name)) {
      context.addIssue({
        code: 'custom',
        message: 'Invoice field names must be unique',
        path: ['fields', index, 'name'],
      });
    }
    fieldNames.add(field.name);
  });

  const columns = new Set<string>();
  template.lineItems?.columns.forEach((column, index) => {
    if (columns.has(column.field)) {
      context.addIssue({
        code: 'custom',
        message: 'Line-item columns must be unique',
        path: ['lineItems', 'columns', index, 'field'],
      });
    }
    columns.add(column.field);
  });
});

const skillBase = {
  name: shortText,
  body: skillBodySchema,
};

const generatedSkillSchema = z.discriminatedUnion('scope', [
  z.object({ ...skillBase, scope: z.literal('global') }).strict(),
  z.object({
    ...skillBase,
    scope: z.literal('project'),
    scopeRef: shortText,
  }).strict(),
  z.object({
    ...skillBase,
    scope: z.literal('workflow'),
    scopeRef: shortText,
  }).strict(),
]);

export const SkillDraftSchema: z.ZodType<SkillDraft> = z.object({
  vendorId: shortText,
  vendorAliases: z.array(shortText).max(32),
  skill: generatedSkillSchema,
  extractionTemplate: InvoiceExtractionTemplateSchema,
}).strict().superRefine((draft, context) => {
  if (new TextEncoder().encode(JSON.stringify(draft)).byteLength > MAX_SKILL_DRAFT_BYTES) {
    context.addIssue({
      code: 'custom',
      message: `Skill draft exceeds ${MAX_SKILL_DRAFT_BYTES} bytes`,
    });
  }
});

export type SkillDraftPayload = z.infer<typeof SkillDraftSchema>;
export type SkillDraftInput = z.input<typeof SkillDraftSchema>;
export type InvoiceExtractionTemplatePayload = z.infer<
  typeof InvoiceExtractionTemplateSchema
>;
