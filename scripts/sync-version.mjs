import { syncVersionFiles } from "./versioning.mjs";

function readAndroidVersionCodeArg(args) {
  const flagIndex = args.findIndex((arg) => arg === "--android-version-code");
  if (flagIndex === -1) return undefined;

  const raw = args[flagIndex + 1];
  if (!raw) {
    throw new Error("Missing value for --android-version-code");
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--android-version-code must be a positive integer");
  }

  return parsed;
}

try {
  const androidVersionCode = readAndroidVersionCodeArg(process.argv.slice(2));
  const result = await syncVersionFiles({ androidVersionCode });

  if (result.changed.length === 0) {
    console.log(`Version files already match ${result.version} (android versionCode ${result.androidVersionCode}).`);
  } else {
    console.log(`Synced version ${result.version} (android versionCode ${result.androidVersionCode}) in:`);
    for (const file of result.changed) {
      console.log(`- ${file}`);
    }
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
