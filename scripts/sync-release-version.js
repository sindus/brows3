const fs = require('fs');
const path = require('path');

const releaseVersion = process.argv[2] || process.env.RELEASE_VERSION;

if (!releaseVersion) {
  console.error('Missing release version. Pass it as an argument or set RELEASE_VERSION.');
  process.exit(1);
}

const root = process.cwd();
const packageJsonPath = path.join(root, 'package.json');
const tauriConfigPath = path.join(root, 'src-tauri', 'tauri.conf.json');
const cargoTomlPath = path.join(root, 'src-tauri', 'Cargo.toml');

const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
packageJson.version = releaseVersion;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, 'utf8'));
tauriConfig.version = releaseVersion;
fs.writeFileSync(tauriConfigPath, `${JSON.stringify(tauriConfig, null, 2)}\n`);

const cargoToml = fs.readFileSync(cargoTomlPath, 'utf8');
if (!/^version = ".*"$/m.test(cargoToml)) {
  console.error('Failed to find Cargo.toml package version');
  process.exit(1);
}

const updatedCargoToml = cargoToml.replace(
  /^version = ".*"$/m,
  `version = "${releaseVersion}"`
);

fs.writeFileSync(cargoTomlPath, updatedCargoToml);

console.log(`Synced release version to ${releaseVersion}`);
