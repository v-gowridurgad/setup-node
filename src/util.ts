import * as core from '@actions/core';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import {parse} from 'smol-toml';

import fs from 'fs';
import path from 'path';

export function getNodeVersionFromFile(versionFilePath: string): string | null {
  return getNodeVersionFromFileInternal(versionFilePath, new Set<string>());
}

function getNodeVersionFromFileInternal(
  versionFilePath: string,
  visited: Set<string>
): string | null {
  if (!fs.existsSync(versionFilePath)) {
    throw new Error(
      `The specified node version file at: ${versionFilePath} does not exist`
    );
  }

  // Guard against cyclic `volta.extends` chains (self- or mutually-referential),
  // which would otherwise recurse until the JS engine throws a stack overflow.
  // Use `fs.realpathSync` so a symlinked loop (different lexical paths pointing
  // at the same real file) is also detected. Fall back to `path.resolve` if
  // realpath fails for any reason (e.g. mocked filesystems in tests).
  let resolvedPath: string;
  try {
    resolvedPath = fs.realpathSync(versionFilePath);
  } catch {
    resolvedPath = path.resolve(versionFilePath);
  }
  if (visited.has(resolvedPath)) {
    const chain = [...visited, resolvedPath].join(' -> ');
    throw new Error(
      `Detected cyclic volta.extends chain in node-version-file resolution: ${chain}`
    );
  }
  visited.add(resolvedPath);

  const contents = fs.readFileSync(versionFilePath, 'utf8');

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
        const extendedFilePath = path.resolve(
          path.dirname(versionFilePath),
          manifest.volta.extends
        );
        if (!fs.existsSync(extendedFilePath)) {
          throw new Error(
            `The volta.extends target at: ${extendedFilePath} does not exist (referenced from ${versionFilePath})`
          );
        }
        core.info('Resolving node version from ' + extendedFilePath);
        return getNodeVersionFromFileInternal(extendedFilePath, visited);
      }

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
  } catch (err) {
    // A cyclic volta.extends error is a real, actionable failure — don't let
    // the JSON-parse fallback silently swallow it and fall through to TOML/regex.
    if (
      err instanceof Error &&
      err.message.startsWith(
        'Detected cyclic volta.extends chain in node-version-file resolution:'
      )
    ) {
      throw err;
    }
    // Same for a missing volta.extends target: swallowing it here makes the
    // plain-text fallback report the version as "{" instead of naming the
    // file that could not be found.
    if (
      err instanceof Error &&
      err.message.startsWith('The volta.extends target at:')
    ) {
      throw err;
    }
    core.info('Node version file is not JSON file');
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
  return found?.groups?.version ?? contents.trim();
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
