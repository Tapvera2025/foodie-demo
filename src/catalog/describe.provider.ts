/**
 * ============================================================================
 * WRITING A DISH DESCRIPTION, WITH A SPARE ENGINE
 * ============================================================================
 *
 * A kitchen types "Khir Kadam" and asks the platform to write the sentence that
 * goes under it on the customer's menu. This module is the part that talks to a
 * language model; the metering, the ledger and the permission check live in the
 * controller, deliberately, because they are decisions about the business and
 * this is a decision about a network call.
 *
 * ----------------------------------------------------------------------------
 * TWO PROVIDERS, TRIED IN ORDER
 * ----------------------------------------------------------------------------
 *
 * Grok answers first. NVIDIA's Nemotron, via OpenRouter, answers when Grok does
 * not — a timeout, a 5xx, a rate limit, an expired balance, a malformed body.
 *
 * The reason for a fallback at all is where this button lives: a stall owner is
 * standing at a tablet in a food court with a menu half-entered. "The provider
 * is having an incident" is not a thing they can act on, and the alternative to
 * a second provider is that the feature is simply down for the afternoon.
 *
 * ----------------------------------------------------------------------------
 * WHAT COUNTS AS FAILURE IS BROADER THAN AN EXCEPTION
 * ----------------------------------------------------------------------------
 *
 * A 200 response carrying an empty string, or a refusal, or nine paragraphs, is
 * a failure of this function's contract even though the HTTP call succeeded.
 * `shape()` below is what turns a model's output into either a usable sentence
 * or an admission that there was not one — and an unusable result falls through
 * to the next provider exactly like a network error does.
 *
 * That matters because of how this is charged. The controller only spends a
 * credit on `ok: true`, so anything this module cannot vouch for is free.
 */

import { config } from '../platform/config.js';
import { log } from '../platform/logger.js';
import { shape } from './describe.shape.js';

export type DescribeProvider = 'GROK' | 'NEMOTRON';

export type DescribeOutcome = 'OK' | 'EMPTY' | 'ERROR' | 'TIMEOUT' | 'ALL_PROVIDERS_FAILED';

export type DescribeAttempt = {
  provider: DescribeProvider;
  model: string;
  outcome: DescribeOutcome;
  durationMs: number;
  /** Present only on `OK`. */
  text?: string;
  /** Never shown to a kitchen; for the log and the ledger. */
  detail?: string;
};

export type DescribeResult =
  | { ok: true; text: string; attempts: DescribeAttempt[] }
  | { ok: false; reason: 'NOT_CONFIGURED' | 'ALL_PROVIDERS_FAILED'; attempts: DescribeAttempt[] };

export type DescribeInput = {
  dishName: string;
  /** Helps the model stay in register — "Sweets" reads differently from "Tandoor". */
  categoryName?: string | null;
  /** VEG / NON_VEG / EGG / JAIN, as the menu holds them. */
  dietaryFlags?: string[];
  /** In paise. Only used to keep the tone proportionate to the price. */
  pricePaise?: number | null;
};

/**
 * ============================================================================
 * THE PROMPT
 * ============================================================================
 *
 * Specific about length, register and forbidden moves, because every one of
 * these constraints exists to stop a failure mode that shows up on a menu:
 *
 *   - LENGTH. The customer's dish card gives this two lines before it clamps.
 *     A model asked for "a description" writes a paragraph, and the useful half
 *     of it lands under a "…".
 *
 *   - NO PRICE, NO WEIGHT, NO CLAIMS ABOUT AVAILABILITY. Those live in real
 *     columns that change without anyone rewriting prose. A description saying
 *     "just ₹128" becomes a lie the day the stall raises the price, and nothing
 *     in the system knows to go and fix the sentence.
 *
 *   - NO HEALTH OR ALLERGEN CLAIMS. "Healthy", "gluten-free" and "safe for
 *     diabetics" are regulated statements about food in India, and a stall that
 *     tapped a button did not decide to make them.
 *
 *   - DO NOT CONTRADICT THE DIETARY MARK. The veg/non-veg mark is a legally
 *     mandated symbol under FSSAI labelling rules. Prose that mentions chicken
 *     under a green mark is worse than no prose.
 *
 *   - NO QUOTES OR MARKDOWN. It goes straight into a text node. A model that
 *     helpfully wraps its answer in quotation marks puts them on the menu.
 */
function buildPrompt(input: DescribeInput): { system: string; user: string } {
  const diet = (input.dietaryFlags ?? []).map((f) => f.toUpperCase());
  const isVeg = diet.includes('VEG') || diet.includes('JAIN');
  const isNonVeg = diet.includes('NON_VEG');
  const hasEgg = diet.includes('EGG');

  const dietLine = isNonVeg
    ? 'This dish is NON-VEGETARIAN.'
    : hasEgg
      ? 'This dish CONTAINS EGG and is not vegetarian by Indian convention.'
      : isVeg
        ? 'This dish is VEGETARIAN. It contains no meat, no fish and no egg — never imply otherwise.'
        : 'The dietary category is unspecified — do not mention meat, fish or egg at all.';

  const system = [
    'You write one-sentence menu descriptions for stalls in an Indian food court.',
    '',
    'Rules, all of them mandatory:',
    '- Between 12 and 30 words. One sentence. Never two.',
    '- Plain sentence case. No quotation marks, no markdown, no emoji, no line breaks.',
    '- Describe taste, texture and preparation. That is all a diner wants here.',
    '- Never mention price, weight, portion size, calories or availability.',
    '- Never make health, medical, dietary-benefit or allergen-free claims.',
    '- Never invent an origin story, an award, a chef, or a family recipe.',
    '- Do not repeat the dish name back if it makes the sentence clumsy.',
    '- Write in Indian English. Keep Indian dish vocabulary as it is.',
    '',
    'Reply with the sentence itself and nothing else — no preamble, no options.',
  ].join('\n');

  const user = [
    `Dish name: ${input.dishName}`,
    input.categoryName ? `Menu section: ${input.categoryName}` : null,
    dietLine,
  ]
    .filter(Boolean)
    .join('\n');

  return { system, user };
}

/**
 * One HTTP call to an OpenAI-shaped chat completions endpoint.
 *
 * Grok and OpenRouter both speak this dialect, so there is one function rather
 * than two adapters that would drift. The differences that DO matter — base
 * URL, key, model, and OpenRouter's attribution headers — are arguments.
 */
async function callChatCompletions(opts: {
  url: string;
  apiKey: string;
  model: string;
  system: string;
  user: string;
  timeoutMs: number;
  extraHeaders?: Record<string, string>;
}): Promise<{ text: string | null; detail?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);

  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
        ...opts.extraHeaders,
      },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: 'system', content: opts.system },
          { role: 'user', content: opts.user },
        ],
        /*
         * Low but not zero. At 0 every paneer dish in the court gets a
         * near-identical sentence, which reads worse than either extreme —
         * a customer scrolling one stall's menu sees the same rhythm nine
         * times. 0.7 varies the phrasing without loosening the constraints.
         */
        temperature: 0.7,
        /*
         * A ceiling in tokens, sized for the 30-word target with room for the
         * model to finish its sentence. It is a cost control, not the length
         * control — `shape()` is the length control, because a token limit
         * truncates mid-word.
         */
        max_tokens: 160,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      /*
       * The body is read for the LOG, never for the kitchen.
       *
       * A provider's error body can name the account, the balance, or the key's
       * prefix. It goes to the server log where the operator can see it, and
       * the kitchen gets a sentence about the feature being unavailable.
       */
      const body = await res.text().catch(() => '');
      return { text: null, detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null } }[];
    };

    return { text: json.choices?.[0]?.message?.content ?? null };
  } finally {
    clearTimeout(timer);
  }
}

/** Is either provider configured at all? Used to disable the button up front. */
export function describeConfigured(): { grok: boolean; nemotron: boolean; any: boolean } {
  const c = config();
  const grok = Boolean(c.XAI_API_KEY);
  const nemotron = Boolean(c.OPENROUTER_API_KEY);
  return { grok, nemotron, any: grok || nemotron };
}

/**
 * Try Grok, then Nemotron. Report every attempt.
 *
 * The `attempts` array comes back on success as well as failure, because
 * "succeeded, but only on the fallback" is the signal that the primary is
 * degrading — and it is invisible if only the winning attempt is recorded.
 */
export async function describeDish(input: DescribeInput): Promise<DescribeResult> {
  const c = config();
  const { system, user } = buildPrompt(input);
  const attempts: DescribeAttempt[] = [];

  const chain: {
    provider: DescribeProvider;
    apiKey: string | undefined;
    url: string;
    model: string;
    extraHeaders?: Record<string, string>;
  }[] = [
    {
      provider: 'GROK',
      apiKey: c.XAI_API_KEY,
      url: 'https://api.x.ai/v1/chat/completions',
      model: c.XAI_MODEL,
    },
    {
      provider: 'NEMOTRON',
      apiKey: c.OPENROUTER_API_KEY,
      url: 'https://openrouter.ai/api/v1/chat/completions',
      model: c.OPENROUTER_MODEL,
      /*
       * OpenRouter asks callers to identify themselves. These are the only two
       * headers it treats specially and both are public strings — no key, no
       * customer data, nothing about the stall.
       */
      extraHeaders: {
        'HTTP-Referer': 'https://foodcourt.local',
        'X-Title': 'Food Court QR Ordering',
      },
    },
  ];

  if (chain.every((p) => !p.apiKey)) {
    return { ok: false, reason: 'NOT_CONFIGURED', attempts };
  }

  for (const p of chain) {
    if (!p.apiKey) continue;

    const started = Date.now();
    try {
      const { text, detail } = await callChatCompletions({
        url: p.url,
        apiKey: p.apiKey,
        model: p.model,
        system,
        user,
        timeoutMs: c.AI_DESCRIPTION_TIMEOUT_MS,
        ...(p.extraHeaders ? { extraHeaders: p.extraHeaders } : {}),
      });

      const shaped = shape(text);
      const durationMs = Date.now() - started;

      if (shaped) {
        attempts.push({
          provider: p.provider,
          model: p.model,
          outcome: 'OK',
          durationMs,
          text: shaped,
        });
        /*
         * Log the fallback, not the success.
         *
         * A working primary is not news. A generation that only completed
         * because the second provider caught it is the earliest warning that
         * the first one is failing, and it is otherwise buried in a ledger
         * nobody reads until the month's bill.
         */
        if (p.provider !== 'GROK') {
          log().warn(
            { provider: p.provider, model: p.model, durationMs },
            'ai description served by the fallback provider',
          );
        }
        return { ok: true, text: shaped, attempts };
      }

      attempts.push({
        provider: p.provider,
        model: p.model,
        outcome: 'EMPTY',
        durationMs,
        ...(detail ? { detail } : {}),
      });
      log().warn(
        { provider: p.provider, model: p.model, detail },
        'ai description provider returned nothing usable',
      );
    } catch (err) {
      const durationMs = Date.now() - started;
      const aborted = err instanceof Error && err.name === 'AbortError';
      attempts.push({
        provider: p.provider,
        model: p.model,
        outcome: aborted ? 'TIMEOUT' : 'ERROR',
        durationMs,
        detail: err instanceof Error ? err.message.slice(0, 200) : 'unknown',
      });
      log().warn(
        { provider: p.provider, model: p.model, aborted, durationMs },
        'ai description provider failed',
      );
    }
  }

  return { ok: false, reason: 'ALL_PROVIDERS_FAILED', attempts };
}
