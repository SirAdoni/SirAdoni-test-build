import {
  slpBulkCreatorAccountCreateSchema,
  slpStageProfileSchema,
} from "../../../../../shared/src/slp/slp-social.schema.js";
import { z } from "zod";
import {
  slurpDiscoveryProfileSchema,
  slurpDiscoveryProfileComplete,
} from "../../modules/discovery/slp-discovery-profile.js";
import { slurpDisclosureMode } from "../../modules/creators/slp-disclosure.js";
import { resolveCreatorSourceSnapshot } from "../../data/creators/slp-source-resolve.js";
import { stageProfileContainsPublicIdentity, stageProfileContainsSourceDetails } from "../feed/slp-feed-contract.js";
import { resolveCreatorArtwork } from "../creators/slp-creators-contract.js";
import { minimizeCreatorSourceSnapshot } from "../../base/identity/slp-source.js";
import { isSlurpFileUniqueConstraintError } from "../../base/host/slp-file-errors.js";
import { resolveSlurpTextConnection } from "../../base/identity/slp-connection.js";
import { logger } from "../../../lib/logger.js";
import {
  slpCheckProviderHost,
  slpIsRateLimitError,
  slpSettleAdaptive,
  slpTransientNetworkCode,
} from "../../base/model/slp-provider-retry.js";
import { resolveBaseUrl } from "../../../services/generation/connection-base-url.js";
import { generateCreatorStageProfileDraft } from "../creators/slp-creators-contract.js";
import type { FastifyInstance } from "fastify";
import type { SlpRouteDeps } from "../viewer/slp-viewer-contract.js";
import { slpSceneRoutes } from "./slp-scene-routes.js";

const slurpBulkCreatorAccountCreateSchema = slpBulkCreatorAccountCreateSchema.extend({
  connectionId: z.string().min(1).nullable().optional(),
});

/**
 * Stage profiles of a bulk add are drafted two at a time, and one at a time after the first "too
 * many requests". Four at once was a burst on the player's writing connection that Slurp's bundled
 * provider neither paced nor retried the way the Engine does for chat, so a connection that serves
 * one request at a time (a free tier, a proxy cap, a phone-local model) refused all but the first
 * Creator. Two keeps a fast connection fast; the retry waits out the one refusal.
 */
const SLP_BULK_DRAFT_CONCURRENCY = 2;

/** What the wizard tells the player about a Creator whose sign-up did not go through. */
function bulkFailureReason(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const dns = slpTransientNetworkCode(error);
  return slpIsRateLimitError(error)
    ? `The sign-up desk was swamped: the writing connection turned this Creator away for too many requests at once. Nothing was lost — try them again in a minute. (${detail})`
    : dns
      ? `The sign-up desk lost the line: this device could not look up the writing connection's address (${dns}). Check the internet connection, then try them again. (${detail})`
      : `This Creator's sign-up form did not come back. Try them again. (${detail})`;
}

const slurpStageProfileSchema = slpStageProfileSchema.extend(slurpDiscoveryProfileSchema.shape);
// Older clients could skip gender and tags; a new Creator needs both so Discover can find them.
const SLURP_NEW_CREATOR_DISCOVERY_MESSAGE = "A new Creator needs a gender and at least 3 tags.";
const slurpCreatorAccountCreateSchema = z
  .object({
    stageProfile: slurpStageProfileSchema.refine(slurpDiscoveryProfileComplete, {
      message: SLURP_NEW_CREATOR_DISCOVERY_MESSAGE,
      path: ["tags"],
    }),
  })
  .strict();
export async function slpOnboardingRoutes(app: FastifyInstance, deps: SlpRouteDeps) {
  const { characterGallery, characters, connections, firstPostQueue, noodle, resolveNoodlerPublicIdentity } = deps;
  app.post("/accounts/:id/noodler", async (req, reply) => {
    const parsed = slurpCreatorAccountCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { id } = req.params as { id: string };
    const publicAccount = await noodle.resolveSourceByEntityId(id);
    if (!publicAccount) {
      return reply.code(404).send({ error: "Noodle account not found" });
    }
    // The shared schema still accepts Secret; Slurp creates it as Hinted.
    parsed.data.stageProfile.disclosureMode = slurpDisclosureMode(parsed.data.stageProfile.disclosureMode);
    const sourceSnapshot = publicAccount ? await resolveCreatorSourceSnapshot(app.db, publicAccount) : null;
    if (
      publicAccount &&
      (stageProfileContainsPublicIdentity(
        parsed.data.stageProfile,
        await resolveNoodlerPublicIdentity(publicAccount),
      ) ||
        (sourceSnapshot && stageProfileContainsSourceDetails(parsed.data.stageProfile, sourceSnapshot)))
    ) {
      return reply.code(400).send({
        error: "Hinted stage profiles cannot use identifying source names or details.",
      });
    }
    try {
      const artwork = await resolveCreatorArtwork({
        characters,
        characterGallery,
        publicAccount,
        disclosureMode: parsed.data.stageProfile.disclosureMode,
      });
      const created = await noodle.createNoodlerAccount(
        publicAccount.kind as "character" | "persona",
        publicAccount.entityId,
        parsed.data.stageProfile,
        undefined,
        sourceSnapshot
          ? minimizeCreatorSourceSnapshot(sourceSnapshot, parsed.data.stageProfile.disclosureMode)
          : undefined,
        artwork.avatarUrl,
        artwork.bannerUrl,
      );
      if (!created) return reply.code(404).send({ error: "Noodle account not found" });
      // A character Creator designs their own Page on a later open; a persona's page is the player's to build.
      if (publicAccount.kind === "character")
        await noodle.updateAccountProfile(created.id, { profile: { pageWanted: true } }).catch(() => undefined); // a missing wish only means no automatic first Page
      const profile = (await noodle.listNoodlerStageProfiles()).find((item) => item.id === created.id);
      if (!profile) throw new Error("Failed to load the created Slurp stage profile.");
      return reply.code(201).send(profile);
    } catch (error) {
      if (isSlurpFileUniqueConstraintError(error, "slurp2_accounts", ["sourceKind", "sourceEntityId"])) {
        return reply.code(409).send({
          error: "A Slurp creator already exists for this Noodle account.",
        });
      }
      throw error;
    }
  });

  app.post("/slurp/accounts/bulk", async (req, reply) => {
    const parsed = slurpBulkCreatorAccountCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { noodleAccountIds, disclosureMode, disclosureExceptions, autoPosting, connectionId, executionId } =
      parsed.data;
    if (noodleAccountIds.length === 0) {
      return reply.code(201).send({ created: [], skipped: [], failed: [], reasons: [], executionId });
    }
    const settings = await noodle.getSettings();
    const connection = await resolveSlurpTextConnection(
      connections,
      connectionId === undefined ? settings.generationConnectionId : connectionId,
    );
    if (!connection) return reply.code(400).send({ error: "The selected writing connection is not available." });
    // Once per batch: a resolver that is down would otherwise fail every Creator one by one.
    const unreachable = await slpCheckProviderHost(resolveBaseUrl(connection));
    if (unreachable) {
      return reply.code(503).send({
        error: `Slurp could not reach the writing connection: looking up ${unreachable.host} failed (getaddrinfo ${unreachable.code}) even after a few tries. Check this device's internet or DNS, then try again. Nobody was signed up yet.`,
      });
    }
    const created: string[] = [];
    const skipped: string[] = [];
    // Operational failures (provider/storage) are reported apart from expected exclusions
    // so a provider outage cannot look like a batch of harmless skips.
    const failed: string[] = [];
    // Creators the player can simply send again: the run failed on the way, not on who they are.
    const retryable: string[] = [];
    // Every exclusion carries a reason against its creator: without one the wizard can only
    // report a count, and one batch can fail for several different causes.
    const reasons: { accountId: string; reason: string }[] = [];
    const noteReason = (accountId: string, reason: string) => {
      reasons.push({ accountId, reason });
    };
    const noteFailure = (noodleAccountId: string, error: unknown) => {
      retryable.push(noodleAccountId);
      failed.push(noodleAccountId);
      noteReason(noodleAccountId, bulkFailureReason(error));
    };
    // The account row and its scheduler settings are two writes. A retry that finds the row
    // already there must still apply the settings, or a creator whose first attempt failed
    // between the two is reported as created while never receiving its auto-posting config.
    const applyAutoPosting = (accountId: string) =>
      noodle.patchAccountSettings(accountId, {
        subtree: "scheduler",
        patch: { autoPosting },
      });
    const settledCreations = await slpSettleAdaptive(
      noodleAccountIds,
      async (noodleAccountId, slowDown) => {
        const publicAccount = await noodle.resolveSourceByEntityId(noodleAccountId);
        const existing = publicAccount
          ? await noodle.getNoodlerAccountForSource(
              publicAccount.kind as "character" | "persona",
              publicAccount.entityId,
            )
          : null;
        if (existing) {
          if (executionId && existing.settings.profile.noodlerWizardExecutionId === executionId) {
            try {
              await applyAutoPosting(existing.id);
              created.push(existing.id);
            } catch (error) {
              logger.error(error, "[slurp] Bulk replay could not apply auto-posting for %s", noodleAccountId);
              noteFailure(noodleAccountId, error);
            }
          } else {
            skipped.push(noodleAccountId);
            noteReason(
              noodleAccountId,
              "Already a Slurp creator from an earlier run. Remove the existing creator first to create it again.",
            );
          }
          return;
        }
        const accountDisclosure = slurpDisclosureMode(disclosureExceptions[noodleAccountId] ?? disclosureMode);
        if (!publicAccount) {
          skipped.push(noodleAccountId);
          noteReason(noodleAccountId, "The source character or persona no longer exists in Noodle.");
          return;
        }
        try {
          const stageProfile = await generateCreatorStageProfileDraft(app.db, {
            request: {
              noodleAccountId,
              disclosureMode: accountDisclosure,
              guidance: "",
            },
            connection,
            // The first "too many requests" drops the batch to one Creator at a time.
            onRateLimit: slowDown,
          });
          // The draft carries form-only keys (notes, source snapshot, revision token) that the strict
          // create schema refuses. Validating them made every open-mode Creator skip with a wrong reason.
          const {
            notes: _notes,
            sourceSnapshot: _draftSnapshot,
            sourceRevisionToken: _draftToken,
            ...generatedProfile
          } = stageProfile as typeof stageProfile & { sourceSnapshot?: unknown; sourceRevisionToken?: unknown };
          const validatedProfile = slurpCreatorAccountCreateSchema.safeParse({ stageProfile: generatedProfile });
          if (!validatedProfile.success) {
            skipped.push(noodleAccountId);
            noteReason(
              noodleAccountId,
              validatedProfile.error.issues.every((issue) => issue.message === SLURP_NEW_CREATOR_DISCOVERY_MESSAGE)
                ? "The generated stage profile did not include a valid gender and at least 3 tags."
                : `The generated stage profile could not be used: ${validatedProfile.error.issues
                    .map((issue) => `${issue.path.slice(1).join(".") || "profile"} ${issue.message}`)
                    .join("; ")}`,
            );
            return;
          }
          const sourceSnapshot = await resolveCreatorSourceSnapshot(app.db, publicAccount);
          // Belt-and-braces: the generator already enforces leak protection, but keep the guard.
          if (
            stageProfileContainsPublicIdentity(stageProfile, await resolveNoodlerPublicIdentity(publicAccount)) ||
            (sourceSnapshot && stageProfileContainsSourceDetails(stageProfile, sourceSnapshot))
          ) {
            skipped.push(noodleAccountId);
            noteReason(
              noodleAccountId,
              "The generated stage profile repeated the linked public identity, so it was rejected. Try again, or set the disclosure mode to open.",
            );
            return;
          }
          const artwork = await resolveCreatorArtwork({
            characters,
            characterGallery,
            publicAccount,
            disclosureMode: accountDisclosure,
          });
          const account = await noodle.createNoodlerAccount(
            publicAccount.kind as "character" | "persona",
            publicAccount.entityId,
            validatedProfile.data.stageProfile,
            executionId,
            sourceSnapshot ? minimizeCreatorSourceSnapshot(sourceSnapshot, accountDisclosure) : undefined,
            artwork.avatarUrl,
            artwork.bannerUrl,
          );
          if (!account) {
            skipped.push(noodleAccountId);
            noteReason(noodleAccountId, "The creator record could not be written.");
            return;
          }
          if (publicAccount.kind === "character")
            await noodle.updateAccountProfile(account.id, { profile: { pageWanted: true } }).catch(() => undefined); // a missing wish only means no automatic first Page
          await applyAutoPosting(account.id);
          created.push(account.id);
        } catch (error) {
          if (isSlurpFileUniqueConstraintError(error, "slurp2_accounts", ["sourceKind", "sourceEntityId"])) {
            const replayed = await noodle.getNoodlerAccountForSource(
              publicAccount.kind as "character" | "persona",
              publicAccount.entityId,
            );
            if (executionId && replayed?.settings.profile.noodlerWizardExecutionId === executionId) {
              // This branch already runs inside the outer catch, so an unguarded throw here would
              // escape the loop and fail the whole batch instead of this one creator.
              try {
                await applyAutoPosting(replayed.id);
                created.push(replayed.id);
              } catch (autoPostingError) {
                logger.error(
                  autoPostingError,
                  "[slurp] Bulk replay could not apply auto-posting for %s",
                  noodleAccountId,
                );
                noteFailure(noodleAccountId, autoPostingError);
              }
            } else {
              skipped.push(noodleAccountId);
              noteReason(
                noodleAccountId,
                "Already a Slurp creator from an earlier run. Remove the existing creator first to create it again.",
              );
            }
            return;
          }
          logger.error(error, "[slurp] Bulk stage profile generation failed for %s", noodleAccountId);
          noteFailure(noodleAccountId, error);
          return;
        }
      },
      SLP_BULK_DRAFT_CONCURRENCY,
    );
    settledCreations.forEach((result, index) => {
      if (result.status === "fulfilled") return;
      const noodleAccountId = noodleAccountIds[index]!;
      logger.error(result.reason, "[slurp] Bulk stage profile setup failed for %s", noodleAccountId);
      noteFailure(noodleAccountId, result.reason);
    });
    const profiles = await noodle.listNoodlerStageProfiles();
    return reply.code(201).send({
      created: profiles.filter((profile) => created.includes(profile.id)),
      skipped,
      failed,
      reasons,
      retryable,
      executionId,
    });
  });

  app.post("/slurp/first-posts/enqueue", async (req, reply) => {
    const parsed = z
      .object({
        executionId: z.string().trim().min(1).max(128),
        accountIds: z.array(z.string().trim().min(1).max(64)).min(1).max(24),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return { jobs: await firstPostQueue.enqueue(parsed.data.executionId, parsed.data.accountIds) };
  });

  app.get("/slurp/first-posts/status", async (req, reply) => {
    const parsed = z.object({ executionId: z.string().trim().min(1).max(128) }).safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    return firstPostQueue.status(parsed.data.executionId);
  });

  await slpSceneRoutes(app, deps);
}
