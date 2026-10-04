// ─────────────────────────────────────────────────────────────
//  Thali — settings you might want to change.
//  Model IDs and prices were checked against
//  https://platform.claude.com/docs/en/models/overview in October 2026.
// ─────────────────────────────────────────────────────────────

export const CONFIG = {
  APP_VERSION: '1.0.0',

  // The two Claude models the app uses. Change the IDs here if Anthropic renames them.
  MODELS: {
    fast: 'claude-haiku-4-5-20251001', // default for every estimate (cheapest with vision)
    accurate: 'claude-sonnet-5-5',     // used by "Re-check with more accurate model"
  },

  // Friendly names shown in the app.
  MODEL_NAMES: {
    'claude-haiku-4-5-20251001': 'Claude Haiku 4.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  },

  // Extra request fields some models need.
  // Sonnet 5.5 thinks before answering by default, which would use up the small
  // max_tokens budget; "between_tools" switches that up-front thinking off.
  MODEL_EXTRA_PARAMS: {
    'claude-sonnet-5-5': { thinking: { type: 'between_tools' } },
  },

  // US dollars per million tokens, used only for the rough cost shown in Settings.
  PRICES_PER_MTOK: {
    'claude-haiku-4-5-20251001': { input: 1, output: 5 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
  },

  API_URL: 'https://api.anthropic.com/v1/messages',
  ANTHROPIC_VERSION: '2023-06-01',
  MAX_TOKENS: 600,
  REQUEST_TIMEOUT_MS: 60000,

  // Photos are shrunk on the phone before sending, to keep costs low.
  IMAGE_MAX_SIDE: 1024,
  IMAGE_QUALITY: 0.7,
  // Small copy kept with each log entry.
  THUMB_MAX_SIDE: 240,
  THUMB_QUALITY: 0.6,
  // Barcode photos are decoded on the phone, so they can stay sharper.
  BARCODE_PHOTO_MAX_SIDE: 2000,

  OFF_PRODUCT_URL: 'https://world.openfoodfacts.org/api/v2/product/',
  OFF_FIELDS: 'code,product_name,product_name_en,generic_name,brands,quantity,serving_size,serving_quantity,nutriments',

  DEFAULT_CALORIE_GOAL: 1800,
  // Automatic macro targets: share of the calorie goal.
  AUTO_MACRO_SPLIT: { protein: 0.20, carbs: 0.50, fat: 0.30 },

  KJ_PER_KCAL: 4.184,
};
