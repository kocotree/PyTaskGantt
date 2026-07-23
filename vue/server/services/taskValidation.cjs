const { z } = require('zod');
const { ValidationError } = require('../errors.cjs');
const { normalizeTags } = require('../../lib/taskTransfer.cjs');

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;

function normalizeTime(value) {
  const text = String(value || '').trim();
  if (!timePattern.test(text)) return text;
  return text.length === 5 ? `${text}:00` : text;
}

const nameSchema = z.string().trim().min(1).max(200);
const timeSchema = z.string().trim().regex(timePattern).transform(normalizeTime);
const botSchema = z.string().trim().min(1).max(100);
const tagsSchema = z.array(z.string().max(50)).max(20).transform(normalizeTags);
const noteSchema = z.string().max(2000);
const MAX_BIGINT = 9223372036854775807n;

function isValidBigintId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return false;
  const text = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(text)) return false;
  try {
    return BigInt(text) <= MAX_BIGINT;
  } catch (_error) {
    return false;
  }
}

const bigintIdSchema = z.union([z.string(), z.number()])
  .refine(isValidBigintId, '任务 ID 必须是 BIGINT 范围内的正整数')
  .transform(value => String(value));

const createMutation = z.object({
  type: z.literal('create'),
  temp_id: z.string().min(1).max(200),
  schedule_uuid: z.string().trim().min(1).max(200),
  task: nameSchema,
  start: timeSchema,
  finish: timeSchema,
  bot: botSchema,
  tags: tagsSchema.optional().default([]),
  note: noteSchema.optional().default(''),
}).strict();

const changesSchema = z.object({
  task: nameSchema.optional(),
  start: timeSchema.optional(),
  finish: timeSchema.optional(),
  bot: botSchema.optional(),
  tags: tagsSchema.optional(),
  note: noteSchema.optional(),
}).strict().refine(value => Object.keys(value).length > 0, '至少需要一个修改字段');

const updateMutation = z.object({
  type: z.literal('update'),
  id: bigintIdSchema,
  version: z.coerce.number().int().positive(),
  changes: changesSchema,
}).strict();

const deleteMutation = z.object({
  type: z.literal('delete'),
  id: bigintIdSchema,
  version: z.coerce.number().int().positive(),
}).strict();

const batchSchema = z.object({
  mutations: z.array(z.discriminatedUnion('type', [createMutation, updateMutation, deleteMutation])).min(1).max(500),
  audit_action: z.enum(['import']).optional(),
}).strict();

function parseBatch(body) {
  const parsed = batchSchema.safeParse(body);
  if (!parsed.success) throw new ValidationError('任务变更数据不正确', parsed.error.flatten());
  const keys = new Set();
  for (const mutation of parsed.data.mutations) {
    const key = mutation.type === 'create' ? `temp:${mutation.temp_id}` : `id:${mutation.id}`;
    if (keys.has(key)) throw new ValidationError(`同一批次不能重复修改任务：${key.replace(/^[^:]+:/, '')}`);
    keys.add(key);
  }
  return parsed.data;
}

module.exports = { parseBatch, normalizeTime, isValidBigintId };
