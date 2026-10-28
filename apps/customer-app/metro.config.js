// Metro config for running inside the pnpm monorepo. pnpm uses a symlinked node_modules that
// Metro's default resolver doesn't traverse, so transitive deps (e.g. @babel/runtime helpers)
// fail to resolve. Watching the workspace root + enabling symlink resolution fixes that.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.unstable_enableSymlinks = true;

module.exports = config;
