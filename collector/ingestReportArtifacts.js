/**
 * Пишет JSON-сводки прогона для шага уведомления в GHA.
 */
"use strict";

const fs = require("fs");
const path = require("path");

function artifactPath(name) {
  const dir = process.env.GITHUB_WORKSPACE || process.cwd();
  return path.join(dir, `.ingest-${name}.json`);
}

function writeIngestArtifact(name, obj) {
  try {
    fs.writeFileSync(artifactPath(name), JSON.stringify(obj || {}, null, 2), "utf8");
  } catch (e) {
    console.warn(`writeIngestArtifact(${name}) failed:`, e.message);
  }
}

function readIngestArtifact(name) {
  try {
    const p = artifactPath(name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  artifactPath,
  writeIngestArtifact,
  readIngestArtifact,
};
