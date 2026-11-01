import { readFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const tag = process.env.GITHUB_REF_NAME ?? process.argv[2];

if (!tag) throw new Error("A release tag is required in GITHUB_REF_NAME or as the first argument");

const releaseVersion = tag.replace(/^v/, "");
if (releaseVersion !== version) {
    throw new Error(`Release tag ${tag} does not match package version ${version}`);
}
