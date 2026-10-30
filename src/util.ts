import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import {parse} from 'smol-toml';
import semver from 'semver';

import fs from 'fs';
import path from 'path';

/** Raised when a `volta.extends` chain is cyclic or too long. */
export class VoltaExtendsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoltaExtendsError';
  }
}

/** Raised when resolution that started inside the workspace escapes it. */
export class NodeVersionFileBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeVersionFileBoundaryError';
  }
}

const MAX_VOLTA_EXTENDS_HOPS = 100;

/** Aliases a node version file may contain that are not semver ranges. */
const NODE_VERSION_ALIASES =
  /^(?:lts\/\*|lts\/[\w.-]+|node|latest|current|stable|\*)$/i;

function isNodeVersionSpec(value: string): boolean {
  return NODE_VERSION_ALIASES.test(value) || semver.validRange(value) !== null;
}

interface NodeVersionFileResolutionContext {
  enforceVoltaExtendsWorkspaceBoundary: boolean;
  workspace: string;
}

function isContainedPath(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);

  return (
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

function isPathWithinWorkspace(filePath: string, workspace: string): boolean {
  const resolvedWorkspace = path.resolve(workspace);
  const resolvedFile = path.resolve(filePath);

  if (!isContainedPath(resolvedWorkspace, resolvedFile)) {
    return false;
  }

  // Missing files keep the normal "does not exist" error from the caller.
  if (!fs.existsSync(resolvedFile)) {
    return true;
  }

  // Also block symlinks that point outside the workspace.
  return isContainedPath(
    fs.realpathSync(resolvedWorkspace),
    fs.realpathSync(resolvedFile)
  );
}

function markVisitedOrThrowOnCycle(
  versionFilePath: string,
  visited: Set<string>
): void {
  const resolvedPath = path.resolve(versionFilePath);

  if (visited.has(resolvedPath)) {
    const chain = [...visited, resolvedPath].join(' -> ');
    throw new VoltaExtendsError(
      `Detected cyclic volta.extends chain in node-version-file resolution: ${chain}`
    );
  }

  if (visited.size >= MAX_VOLTA_EXTENDS_HOPS) {
    throw new VoltaExtendsError(
      `Exceeded the maximum of ${MAX_VOLTA_EXTENDS_HOPS} volta.extends hops while resolving the node version file starting at ${[...visited][0]}`
    );
  }

  visited.add(resolvedPath);
}

export function getNodeVersionFromFile(versionFilePath: string): string | null {
  // Fall back to the working directory so the boundary is still enforced if
  // GITHUB_WORKSPACE is somehow unset, rather than silently allowing traversal.
  const workspace = process.env.GITHUB_WORKSPACE || process.cwd();

  // Only enforce the boundary when resolution starts inside the workspace, so
  // existing absolute paths outside the workspace keep working. A file outside
  // the workspace is supplied by the workflow author, not by repository
  // content, so it is trusted and its chain is left unconstrained.
  const startsInsideWorkspace = isContainedPath(
    path.resolve(workspace),
    path.resolve(versionFilePath)
  );

  if (
    startsInsideWorkspace &&
    !isPathWithinWorkspace(versionFilePath, workspace)
  ) {
    throw new NodeVersionFileBoundaryError(
      `The node-version-file '${versionFilePath}' resolves outside GITHUB_WORKSPACE and is not allowed`
    );
  }

  return resolveNodeVersionFromFile(versionFilePath, new Set<string>(), {
    enforceVoltaExtendsWorkspaceBoundary: startsInsideWorkspace,
    workspace
  });
}

function resolveNodeVersionFromFile(
  versionFilePath: string,
  visited: Set<string>,
  context: NodeVersionFileResolutionContext
): string | null {
  // A file reached through volta.extends must be a manifest. Falling back to
  // raw-text parsing for it would echo the contents of any readable file into
  // the log (e.g. the token actions/checkout writes to .git/config).
  const isExtendsTarget = visited.size > 0;

  if (!fs.existsSync(versionFilePath)) {
    throw new Error(
      `The specified node version file at: ${versionFilePath} does not exist`
    );
  }

  markVisitedOrThrowOnCycle(versionFilePath, visited);

  const contents = fs.readFileSync(versionFilePath, 'utf8');

  // Resolved after the JSON parsing below so errors from the extended file are
  // not mistaken for "this file is not JSON".
  let extendedFilePath: string | null = null;

  // Try parsing the file as an NPM `package.json` file.
  try {
    const manifest = JSON.parse(contents);

    // Presume package.json file.
    if (typeof manifest === 'object' && !!manifest) {
      // Support Volta.
      // See https://docs.volta.sh/guide/understanding#managing-your-project
      if (manifest.volta?.node) {
        return manifest.volta.node;
      }

      // support devEngines from npm 11
      if (manifest.devEngines?.runtime) {
        // find an entry with name set to node and having set a version.
        // the devEngines.runtime can either be an object or an array of objects
        const nodeEntry = [manifest.devEngines.runtime]
          .flat()
          .find(({name, version}) => name?.toLowerCase() === 'node' && version);
        if (nodeEntry) {
          return nodeEntry.version;
        }
      }

      if (manifest.engines?.node) {
        return manifest.engines.node;
      }

      // Support Volta workspaces.
      // See https://docs.volta.sh/advanced/workspaces
      if (manifest.volta?.extends) {
        if (typeof manifest.volta.extends !== 'string') {
          throw new VoltaExtendsError(
            `The volta.extends value in ${versionFilePath} must be a string, received ${typeof manifest.volta.extends}`
          );
        }

        extendedFilePath = path.resolve(
          path.dirname(versionFilePath),
          manifest.volta.extends
        );
      } else {
        // If contents are an object, we parsed JSON
        // this can happen if node-version-file is a package.json
        // yet contains no volta.node or engines.node
        //
        // If node-version file is _not_ JSON, control flow
        // will not have reached these lines.
        //
        // And because we've reached here, we know the contents
        // *are* JSON, so no further string parsing makes sense.
        return null;
      }
    }
  } catch (err) {
    // A malformed volta.extends is a real configuration error, not a signal
    // that the file is not JSON, so it must not fall through to text parsing.
    if (err instanceof VoltaExtendsError) {
      throw err;
    }

    core.info('Node version file is not JSON file');
  }

  if (extendedFilePath !== null) {
    if (
      context.enforceVoltaExtendsWorkspaceBoundary &&
      !isPathWithinWorkspace(extendedFilePath, context.workspace)
    ) {
      throw new NodeVersionFileBoundaryError(
        `The volta.extends target '${extendedFilePath}' resolves outside GITHUB_WORKSPACE and is not allowed`
      );
    }

    core.info('Resolving node version from ' + extendedFilePath);
    return resolveNodeVersionFromFile(extendedFilePath, visited, context);
  }

  // Try parsing the file as a mise `mise.toml` file.
  try {
    const manifest: Record<string, any> = parse(contents);
    if (manifest?.tools?.node) {
      const node = manifest.tools.node;

      if (typeof node === 'object' && node?.version) {
        return node.version;
      }

      if (typeof node === 'string') {
        return node;
      }

      return null;
    }
  } catch {
    core.info('Node version file is not TOML file');
  }

  const found = contents.match(/^(?:node(js)?\s+)?v?(?<version>[^\s]+)$/m);
  const version = found?.groups?.version ?? contents.trim();

  // A volta.extends target must declare a node version. Returning arbitrary
  // text would echo the contents of any readable file into the log, including
  // the token actions/checkout writes to .git/config inside the workspace.
  if (isExtendsTarget && !isNodeVersionSpec(version)) {
    throw new VoltaExtendsError(
      `The volta.extends target ${versionFilePath} does not declare a node version`
    );
  }

  return version;
}

export async function printEnvDetailsAndSetOutput() {
  core.startGroup('Environment details');
  const promises = ['node', 'npm', 'yarn'].map(async tool => {
    const pathTool = await io.which(tool, false);
    const output = pathTool ? await getToolVersion(tool, ['--version']) : '';

    return {tool, output};
  });

  const tools = await Promise.all(promises);
  tools.forEach(({tool, output}) => {
    if (tool === 'node') {
      core.setOutput(`${tool}-version`, output);
    }
    core.info(`${tool}: ${output}`);
  });

  core.endGroup();
}

async function getToolVersion(tool: string, options: string[]) {
  try {
    const {stdout, stderr, exitCode} = await exec.getExecOutput(tool, options, {
      ignoreReturnCode: true,
      silent: true
    });

    if (exitCode > 0) {
      core.info(`[warning]${stderr}`);
      return '';
    }

    return stdout.trim();
  } catch {
    return '';
  }
}

export const unique = () => {
  const encountered = new Set();
  return (value: unknown): boolean => {
    if (encountered.has(value)) return false;
    encountered.add(value);
    return true;
  };
};
