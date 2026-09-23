import { checkVersionDrift } from "./versioning.mjs";

try {
  const result = await checkVersionDrift();

  if (result.mismatches.length === 0) {
    console.log(`Version files are in sync for ${result.version}.`);
    process.exit(0);
  }

  console.error(`Version drift detected for ${result.version}:`);
  for (const file of result.mismatches) {
    console.error(`- ${file}`);
  }
  console.error("Run `pnpm version:sync` after updating the root package.json version.");
  process.exit(1);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
