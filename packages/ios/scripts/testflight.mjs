import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, sign } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`Missing ${name}`);
  return env[name];
};
const appId = required("IOS_ASC_APP_ID");
const team = required("IOS_TEAM_ID");
const keyId = required("ASC_API_KEY_ID");
const issuer = required("ASC_API_ISSUER_ID");
const buildNumber = required("IOS_BUILD_NUMBER");
if (
  !/^\d+$/.test(appId) ||
  !/^[A-Z0-9]{10}$/.test(team) ||
  !/^[A-Z0-9]{10}$/.test(keyId) ||
  !/^\d{1,4}\.\d{1,2}$/.test(buildNumber)
)
  throw new Error("Invalid iOS release identity or build number");
const privateKey = Buffer.from(required("ASC_API_KEY_P8_BASE64"), "base64");
const key = createPrivateKey(privateKey);
const api = async (path) => {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const payload =
    encode({ alg: "ES256", kid: keyId, typ: "JWT" }) +
    "." +
    encode({
      iss: issuer,
      aud: "appstoreconnect-v1",
      iat: now,
      exp: now + 120,
    });
  const signature = sign("sha256", Buffer.from(payload), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  const response = await fetch(
    "https://api.appstoreconnect.apple.com/v1/" + path,
    {
      headers: { authorization: "Bearer " + payload + "." + signature },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw new Error(
      `App Store Connect GET ${path.split("?")[0]} returned ${response.status}`,
    );
  return (await response.json()).data;
};
const app = await api("apps/" + appId);
if (app.attributes.bundleId !== "com.yepanywhere.ios")
  throw new Error("Wrong App Store Connect application");
const group = (await api(`apps/${appId}/betaGroups`)).find(
  (g) => g.attributes.name === "Internal" && g.attributes.isInternalGroup,
);
if (!group?.attributes.hasAccessToAllBuilds)
  throw new Error("Enable automatic distribution for the Internal group");
function run(command, args, capture = false) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0) throw new Error(command + " failed");
  return result.stdout;
}
const readPlist = (file, field) => {
  const result = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", "Print :" + field, file],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error("Missing archive metadata " + field);
  return result.stdout.trim();
};
const builds = (version) =>
  api(
    "builds?" +
      new URLSearchParams({
        "filter[app]": appId,
        "filter[version]": buildNumber,
        "filter[preReleaseVersion.version]": version,
      }),
  );

async function upload() {
  const archive = required("IOS_ARCHIVE_PATH");
  const product = join(archive, "Products/Applications/YepAnywhere.app");
  const plist = join(product, "Info.plist");
  if (
    readPlist(plist, "CFBundleIdentifier") !== app.attributes.bundleId ||
    readPlist(plist, "CFBundleVersion") !== buildNumber ||
    readPlist(join(product, "GoogleService-Info.plist"), "BUNDLE_ID") !==
      app.attributes.bundleId
  )
    throw new Error(
      "Archive identity, version or Firebase configuration mismatch",
    );
  const version = readPlist(plist, "CFBundleShortVersionString");
  if ((await builds(version)).length)
    throw new Error(
      "Build already exists; inspect its delivery before retrying",
    );
  const dir = await mkdtemp(join(tmpdir(), "ya-testflight-"));
  try {
    await chmod(dir, 0o700);
    const path = join(dir, "AuthKey_" + keyId + ".p8");
    const options = join(dir, "ExportOptions.plist");
    await writeFile(path, privateKey, { mode: 0o600 });
    await writeFile(
      options,
      `<?xml version="1.0"?><plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string><key>destination</key><string>export</string>
<key>signingStyle</key><string>automatic</string><key>teamID</key><string>${team}</string>
<key>manageAppVersionAndBuildNumber</key><false/><key>testFlightInternalTestingOnly</key><true/>
<key>uploadSymbols</key><true/></dict></plist>`,
    );
    // An archive built without signing has no executable entitlements. Xcode
    // otherwise exports a valid IPA that silently lacks production push.
    const entitlements = join(dir, "requested.plist");
    await writeFile(
      entitlements,
      '<plist version="1.0"><dict><key>aps-environment</key><string>production</string></dict></plist>',
    );
    run("codesign", [
      "--force",
      "--sign",
      "-",
      "--generate-entitlement-der",
      "--entitlements",
      entitlements,
      product,
    ]);
    const exported = join(dir, "export");
    run("xcodebuild", [
      "-exportArchive",
      "-archivePath",
      archive,
      "-exportOptionsPlist",
      options,
      "-exportPath",
      exported,
      "-allowProvisioningUpdates",
      "-authenticationKeyPath",
      path,
      "-authenticationKeyID",
      keyId,
      "-authenticationKeyIssuerID",
      issuer,
    ]);
    const ipas = (await readdir(exported)).filter((name) =>
      name.endsWith(".ipa"),
    );
    if (ipas.length !== 1) throw new Error("Expected one distribution IPA");
    const ipa = join(exported, ipas[0]);
    const check = join(dir, "check");
    run("ditto", ["-x", "-k", ipa, check]);
    const signed = join(check, "Payload", "YepAnywhere.app");
    run("codesign", ["--verify", "--deep", "--strict", signed]);
    const verified = join(dir, "signed.plist");
    await writeFile(
      verified,
      run("codesign", ["-d", "--entitlements", "-", "--xml", signed], true),
    );
    if (
      readPlist(verified, "aps-environment") !== "production" ||
      readPlist(verified, "application-identifier") !==
        team + "." + app.attributes.bundleId ||
      readPlist(verified, "get-task-allow") !== "false" ||
      readPlist(join(signed, "Info.plist"), "CFBundleVersion") !== buildNumber
    )
      throw new Error(
        "Signed IPA failed production entitlement or version verification",
      );
    run("xcrun", [
      "altool",
      "--upload-app",
      "-f",
      ipa,
      "--type",
      "ios",
      "--api-key",
      keyId,
      "--api-issuer",
      issuer,
      "--p8-file-path",
      path,
    ]);
    const digest = createHash("sha256")
      .update(await readFile(ipa))
      .digest("hex");
    await appendFile(
      required("GITHUB_OUTPUT"),
      "version=" + version + "\nsha256=" + digest + "\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function verify() {
  const version = required("IOS_VERSION");
  const sha256 = required("IOS_IPA_SHA256");
  if (!/^[a-f0-9]{64}$/.test(sha256))
    throw new Error("Missing signed IPA fingerprint");
  let delivered = false;
  const deadline = Date.now() + 25 * 60_000;
  while (Date.now() < deadline) {
    const [build] = await builds(version);
    if (build?.attributes.processingState === "VALID") {
      const detail = await api("builds/" + build.id + "/buildBetaDetail");
      const state = detail.attributes.internalBuildState;
      console.log("Apple internal build state:", state);
      if (state === "MISSING_EXPORT_COMPLIANCE")
        throw new Error(
          "Apple requires the build encryption declaration; preserve the reviewed non-exempt answers and France exclusion.",
        );
      const members = await api(
        "betaGroups/" + group.id + "/relationships/builds?limit=200",
      );
      if (
        ["IN_BETA_TESTING", "READY_FOR_BETA_TESTING"].includes(state) &&
        members.some((b) => b.id === build.id)
      ) {
        const receipt = {
          appId,
          version,
          buildNumber,
          buildId: build.id,
          sha256,
          commit: required("GITHUB_SHA"),
          group: group.attributes.name,
          state,
        };
        await writeFile(
          required("IOS_DELIVERY_RECEIPT"),
          JSON.stringify(receipt, null, 2),
        );
        console.log(receipt);
        delivered = true;
        break;
      }
    } else if (build && build.attributes.processingState !== "PROCESSING")
      throw new Error(
        "Apple build processing: " + build.attributes.processingState,
      );
    await pause(15000);
  }
  if (!delivered)
    throw new Error("Timed out waiting for the processed build in Internal");
}
if (process.argv[2] === "upload") await upload();
else if (process.argv[2] === "verify") await verify();
else throw new Error("Expected upload or verify");
