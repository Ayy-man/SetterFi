/**
 * Measures the active moderator model against evals/corpus/moderator.json.
 *
 * Invoke with the hosted project's variables already exported in the shell (the script reads no
 * .env file), for example:
 *
 *   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... OPENROUTER_API_KEY=... \
 *     npx --yes tsx scripts/eval-moderator.ts [--only <category>] [--limit <n>]
 *
 * Reads the single active `model_configs` row with role "moderator" through the service role,
 * builds the real OpenRouter moderator driver, runs every corpus case once, and prints the
 * summary plus every incorrect case as JSON on stdout. Credential values are never printed;
 * a missing variable is reported by name only.
 */

import { createClient } from "@supabase/supabase-js";

import { createRealModeratorDriver } from "@/lib/integrations/openrouter";
import type { ActiveModelConfiguration } from "@/lib/integrations/selector";
import { loadModeratorCorpus, MODERATOR_CASE_CATEGORIES } from "@/lib/evals/moderator-corpus";
import { runModeratorCorpus } from "@/lib/evals/moderator-eval";

const REQUIRED_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "OPENROUTER_API_KEY"] as const;

function requireEnvironment() {
  const missing = REQUIRED_NAMES.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`MODERATOR_EVAL_ENV_MISSING:${missing.join(",")}`);
  }
  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
    openRouterKey: process.env.OPENROUTER_API_KEY as string,
  };
}

function parseArguments(argv: readonly string[]) {
  let only: string | null = null;
  let limit: number | null = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--only") {
      only = argv[index + 1] ?? null;
      index += 1;
    } else if (argument === "--limit") {
      limit = Number(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`MODERATOR_EVAL_UNKNOWN_ARGUMENT:${argument}`);
    }
  }
  if (only !== null && !(MODERATOR_CASE_CATEGORIES as readonly string[]).includes(only)) {
    throw new Error(`MODERATOR_EVAL_UNKNOWN_CATEGORY:${only}`);
  }
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error("MODERATOR_EVAL_LIMIT_INVALID");
  }
  return { only, limit };
}

async function loadActiveModerator(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<ActiveModelConfiguration & { id: string }> {
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.from("model_configs")
    .select("id,openrouter_model,params").eq("role", "moderator").eq("active", true);
  if (error) throw new Error(`MODERATOR_EVAL_CONFIG_READ_FAILED:${error.message}`);
  if (!data || data.length !== 1) {
    throw new Error(`MODERATOR_EVAL_ACTIVE_MODERATOR_REQUIRED:${data?.length ?? 0}`);
  }
  const row = data[0];
  const params = row.params;
  return {
    id: String(row.id),
    role: "moderator",
    model: String(row.openrouter_model),
    params: params && typeof params === "object" && !Array.isArray(params)
      ? (params as Record<string, unknown>)
      : {},
  };
}

async function main() {
  const { only, limit } = parseArguments(process.argv.slice(2));
  const environment = requireEnvironment();
  const configuration = await loadActiveModerator(environment.supabaseUrl, environment.serviceRoleKey);
  const driver = createRealModeratorDriver(environment.openRouterKey, configuration);
  const corpus = loadModeratorCorpus();
  const selected = corpus.cases
    .filter((testCase) => only === null || testCase.category === only)
    .slice(0, limit ?? corpus.cases.length);

  process.stderr.write(
    `moderator ${configuration.model} (model_configs ${configuration.id}), ` +
    `${selected.length} of ${corpus.cases.length} cases, corpus ${corpus.revision.slice(0, 12)}\n`,
  );

  const { results, summary } = await runModeratorCorpus({
    moderate: (payload) => driver.moderate(payload),
    cases: selected,
  });

  const byCategory = Object.fromEntries(
    MODERATOR_CASE_CATEGORIES
      .map((category) => [category, results.filter((result) => result.category === category)] as const)
      .filter(([, rows]) => rows.length > 0)
      .map(([category, rows]) => [category, {
        total: rows.length,
        correct: rows.filter((row) => row.correct).length,
      }]),
  );

  console.log(JSON.stringify({
    moderator: { model: configuration.model, modelConfigId: configuration.id, params: configuration.params },
    corpusRevision: corpus.revision,
    summary,
    byCategory,
    incorrect: results.filter((result) => !result.correct),
  }, null, 2));

  process.exitCode = summary.falseAllows > 0 || summary.errors > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
});
