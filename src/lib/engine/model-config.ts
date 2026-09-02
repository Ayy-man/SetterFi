/**
 * Resolves the two active model roles without reading environment or provider state.
 *
 * Candidate model IDs remain database configuration. The only invariant enforced here is that
 * generation and moderation cannot resolve to the same model vendor prefix.
 */

export type ModelConfigRow = {
  id: string;
  role: "generator" | "moderator";
  openrouterModel: string;
  params: Record<string, unknown>;
  active: boolean;
};

export class ModelConfigurationError extends Error {
  constructor(code: string) {
    super(code);
    this.name = "ModelConfigurationError";
  }
}

function vendor(model: string) {
  const separator = model.indexOf("/");
  if (separator <= 0) throw new ModelConfigurationError("MODEL_VENDOR_PREFIX_REQUIRED");
  return model.slice(0, separator).toLowerCase();
}

/**
 * The same active-only view of the table, in the shape `selectModelDrivers` reads.
 *
 * The driver selector's `requireModelPair` counts exactly one generator and one moderator and
 * throws a DriverConfigurationError naming SETTERFI_OPENROUTER_DRIVER when it sees more, so an
 * inactive row — a parked A/B challenger, which is the whole point of keeping the column — read
 * as a second generator and made the engine unreachable no matter what the environment held.
 * Filtering lives here, beside `loadActiveModelPair`, so the rule is stated once.
 */
export function activeModelConfigurations(rows: readonly ModelConfigRow[]) {
  return rows
    .filter((row) => row.active)
    .map((row) => ({ role: row.role, model: row.openrouterModel, params: row.params }));
}

export function loadActiveModelPair(rows: readonly ModelConfigRow[]) {
  const active = rows.filter((row) => row.active);
  const generators = active.filter((row) => row.role === "generator");
  const moderators = active.filter((row) => row.role === "moderator");
  if (generators.length !== 1) throw new ModelConfigurationError("ACTIVE_GENERATOR_REQUIRED");
  if (moderators.length !== 1) throw new ModelConfigurationError("ACTIVE_MODERATOR_REQUIRED");
  if (vendor(generators[0].openrouterModel) === vendor(moderators[0].openrouterModel)) {
    throw new ModelConfigurationError("MODEL_VENDORS_MUST_DIFFER");
  }
  return { generator: generators[0], moderator: moderators[0] };
}
