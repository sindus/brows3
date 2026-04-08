const fs = require('fs');
const path = require('path');

const changelogPath = path.join(process.cwd(), 'CHANGELOG.md');
const version = require(path.join(process.cwd(), 'package.json')).version;
const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

try {
  const content = fs.readFileSync(changelogPath, 'utf8');
  
  // Regex to match the current version section
  // Matches: ## [x.x.x] - date ... content ... until next ## [x.x.x] or eof
  const regex = new RegExp(`## \\[${escapedVersion}\\] - \\d{4}-\\d{2}-\\d{2}([\\s\\S]*?)(?=## \\[|$)`, 'i');
  
  const match = content.match(regex);
  
  if (match && match[1]) {
    // Trim and clean up
    const notes = match[1].trim();
    console.log(`Brows3 ${version} release notes\n\n${notes}`);
  } else {
    console.error(`Could not find release notes for version ${version}`);
    process.exit(1);
  }
} catch (err) {
  console.error('Error reading changelog:', err);
  process.exit(1);
}
