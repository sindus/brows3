const fs = require('fs');
const path = require('path');

const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
const version = process.env.RELEASE_VERSION || require(path.join(process.cwd(), 'package.json')).version;
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const packageVersion = require(path.join(process.cwd(), 'package.json')).version;
const escapedPackageVersion = packageVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function extractSection(content, targetVersion) {
  const regex = new RegExp(`## \\[${targetVersion}\\] - \\d{4}-\\d{2}-\\d{2}([\\s\\S]*?)(?=## \\[|$)`, 'i');
  const match = content.match(regex);
  return match && match[1] ? match[1].trim() : null;
}

try {
  const content = fs.readFileSync(changelogPath, 'utf8');

  const notes =
    extractSection(content, escapedVersion) ||
    extractSection(content, escapedPackageVersion);

  if (notes) {
    console.log(`Brows3 ${version} release notes\n\n${notes}`);
    process.exit(0);
  }

  const latestSection = content.match(/## \[[^\]]+\] - \d{4}-\d{2}-\d{2}([\s\S]*?)(?=## \[|$)/i);
  if (latestSection && latestSection[1]) {
    console.log(`Brows3 ${version} release notes\n\n${latestSection[1].trim()}`);
    process.exit(0);
  }

  console.log(`Brows3 ${version}\n\nAutomated release from the latest main branch changes.`);
} catch (err) {
  console.log(`Brows3 ${version}\n\nAutomated release from the latest main branch changes.`);
}
