/**
 * Firebase Admin init for ingest scripts.
 * Prefers env (CI): FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS.
 * Local fallback: service account JSON next to repo root.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const admin = require("firebase-admin");

const expectedDevProjectId = process.env.DEV_PROJECT_ID || "brickinfuture-306f1";

function parseServiceAccountJson(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("empty service account JSON");
  try {
    return JSON.parse(s);
  } catch (e1) {
    // GHA `echo "$JSON" > file` can inject literal newlines inside private_key.
    const fixed = s.replace(
      /("private_key"\s*:\s*")([\s\S]*?)("\s*,\s*"client_email")/,
      (_, pre, key, post) => pre + key.replace(/\r?\n/g, "\\n") + post
    );
    try {
      return JSON.parse(fixed);
    } catch (e2) {
      throw new Error(`invalid service account JSON: ${e1.message}`);
    }
  }
}

function loadServiceAccount() {
  const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (rawJson && String(rawJson).trim()) {
    return parseServiceAccountJson(rawJson);
  }

  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath && fs.existsSync(credPath)) {
    return parseServiceAccountJson(fs.readFileSync(credPath, "utf8"));
  }

  const localPath = path.resolve(
    __dirname,
    "..",
    "..",
    "brickinfuture-306f1-firebase-adminsdk-fbsvc-e5ee46743d.json"
  );
  if (fs.existsSync(localPath)) {
    return require(localPath);
  }

  throw new Error(
    "No Firebase credentials: set FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS"
  );
}

function assertDevProject(projectId) {
  if (projectId !== expectedDevProjectId && process.env.ALLOW_NON_DEV_PROJECT !== "1") {
    throw new Error(
      `Refusing to run: project "${projectId}" does not match DEV_PROJECT_ID "${expectedDevProjectId}". Set ALLOW_NON_DEV_PROJECT=1 for prod.`
    );
  }
}

function initFromAdc(projectId) {
  assertDevProject(projectId);
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId,
  });
  return { admin, db: admin.firestore(), FieldValue: admin.firestore.FieldValue };
}

function initFirebaseAdmin() {
  if (admin.apps.length) {
    return { admin, db: admin.firestore(), FieldValue: admin.firestore.FieldValue };
  }

  const adcProjectId =
    process.env.DEV_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || expectedDevProjectId;
  const onGcp = Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.CLOUD_RUN_JOB);

  let serviceAccount = null;
  try {
    serviceAccount = loadServiceAccount();
  } catch (err) {
    if (!onGcp) throw err;
    return initFromAdc(adcProjectId);
  }

  const projectId = serviceAccount.project_id || adcProjectId;
  assertDevProject(projectId);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId,
  });

  return { admin, db: admin.firestore(), FieldValue: admin.firestore.FieldValue };
}

module.exports = {
  initFirebaseAdmin,
  expectedDevProjectId,
};
