import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { existsSync, readFileSync, statSync } from 'fs'
import { homedir } from 'os'
import findUp from 'next/dist/compiled/find-up'
import * as Log from '../build/output/log'

export type RootBoundary = {
  boundary: string
  root: string
  type: 'repository' | 'home'
}

// folders that are git checkouts / git worktrees are a good indicator
// of the folder that someone's project is contained in.
type GitBoundary =
  | { type: 'repository'; dir: string }
  | { type: 'worktree'; dir: string }

// if `descendant` is inside of `ancestor` or `descendant` == `ancestor`
function isAncestorOrSelf(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// if `descendant` is inside of `ancestor`
function isStrictAncestor(ancestor: string, descendant: string): boolean {
  const rel = relative(ancestor, descendant)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// true for a git worktree (its git dir has a `commondir` file);
// this method returns false for a submodule.
function isGitWorktree(dir: string, gitFile: string): boolean {
  let contents: string
  try {
    contents = readFileSync(gitFile, 'utf8')
  } catch {
    return false
  }

  const match = /^gitdir:\s*(.*)$/m.exec(contents)
  if (!match) return false

  const gitDir = resolve(dir, match[1].trim())
  return existsSync(join(gitDir, 'commondir'))
}

// finds the first git repository or git worktree above the
// current working directory. we limit the project root to
// inside a worktree or git repository. this is because if
// you use worktrees, you will have lock files from the
// parent git repo that are in folders that are not relevant
// to watch.
function findGitBoundary(cwd: string): GitBoundary | undefined {
  let dir = cwd
  while (true) {
    const gitPath = join(dir, '.git')
    let isDirectory: boolean | undefined
    try {
      isDirectory = statSync(gitPath).isDirectory()
    } catch {
      isDirectory = undefined
    }

    if (isDirectory === true) {
      return { type: 'repository', dir }
    }
    if (isDirectory === false && isGitWorktree(dir, gitPath)) {
      return { type: 'worktree', dir }
    }

    const parentDir = dirname(dir)
    if (parentDir === dir) return undefined
    dir = parentDir
  }
}

const LOCK_FILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
]

// this function is for checking that a lockfile makes a folder
// worthwhile watching. if the lockfile is empty, we don't
// need to watch this folder as it was probably created by
// accident - oops.
function isEmptyLockfile(directory: string, name: string): boolean {
  let contents: string
  try {
    contents = readFileSync(join(directory, name), 'utf8')
  } catch {
    return true
  }

  if (contents.trim() === '') return true
  if (!existsSync(join(directory, 'package.json'))) return true

  // catch lockfiles with no packages
  switch (name) {
    case 'package-lock.json': {
      try {
        const { packages } = JSON.parse(contents)
        if (!packages || Object.keys(packages).length === 0) return true
      } catch {
        return true
      }
      break
    }
    case 'yarn.lock': {
      // A dependency-free `yarn install` writes only header comments.
      const hasEntry = contents.split('\n').some((line) => {
        const trimmed = line.trim()
        return trimmed !== '' && !trimmed.startsWith('#')
      })
      if (!hasEntry) return true
      break
    }
    case 'pnpm-lock.yaml': {
      // A dependency-free `pnpm install` omits the `packages:` section.
      if (!/^packages:/m.test(contents)) return true
      break
    }
  }

  return false
}

// Dedicated workspace-root files. pnpm and Lerna declare the root this way.
const WORKSPACE_MARKERS = ['pnpm-workspace.yaml', 'lerna.json']

// npm, Yarn, and Bun declare the root via a package.json `workspaces` field,
// which may be an array or an object (e.g. Yarn's `{ packages: [...] }`).
function hasWorkspacesField(packageJson: string): boolean {
  try {
    return JSON.parse(readFileSync(packageJson, 'utf8')).workspaces != null
  } catch {
    return false
  }
}

function findWorkspaceMarker(directory: string): string | undefined {
  for (const name of WORKSPACE_MARKERS) {
    if (existsSync(join(directory, name))) {
      return join(directory, name)
    }
  }

  const packageJson = join(directory, 'package.json')
  return hasWorkspacesField(packageJson) ? packageJson : undefined
}

function findWorkRoot(cwd: string) {
  // a workspace marker takes precedence over lockfiles, which can be included in
  // the application directory by accident.
  const marker = findUp.sync(findWorkspaceMarker, { cwd })
  if (marker) {
    return marker
  }

  return findUp.sync(
    (directory) => {
      for (const name of LOCK_FILES) {
        if (!isEmptyLockfile(directory, name)) {
          return join(directory, name)
        }
      }
      return undefined
    },
    {
      cwd,
    }
  )
}

export function findRootDirAndLockFiles(cwd: string): {
  lockFiles: string[]
  rootDir: string
  boundary?: RootBoundary
} {
  const lockFile = findWorkRoot(cwd)
  if (!lockFile)
    return {
      lockFiles: [],
      rootDir: cwd,
    }

  const lockFiles = [lockFile]
  while (true) {
    const lastLockFile = lockFiles[lockFiles.length - 1]
    const currentDir = dirname(lastLockFile)
    const parentDir = dirname(currentDir)

    // dirname('/')==='/' so if we happen to reach the FS root (as might happen in a container we need to quit to avoid looping forever
    if (parentDir === currentDir) break

    const newLockFile = findWorkRoot(parentDir)

    if (!newLockFile) break

    lockFiles.push(newLockFile)
  }

  // filter out lockfiles that would push the root past a
  // git boundary or into the home directory.
  const homeDir = homedir()
  const gitBoundary = findGitBoundary(cwd)

  const acceptedLockFiles: string[] = []
  let boundary: RootBoundary | undefined

  for (const candidate of lockFiles) {
    const dir = dirname(candidate)

    // the app's own directory is always a valid root. even if it
    // is the home directory.
    if (dir !== cwd) {
      // `dir` sits above the repo or worktree that contains the app.
      if (gitBoundary && isStrictAncestor(dir, gitBoundary.dir)) {
        // add a warning for going beyond a repository
        if (gitBoundary.type === 'repository') {
          boundary = {
            boundary: gitBoundary.dir,
            root: dir,
            type: 'repository',
          }
        }
        break
      }

      // never treat the home directory (or above) as the root.
      if (isAncestorOrSelf(dir, homeDir)) {
        boundary = { boundary: homeDir, root: dir, type: 'home' }
        break
      }
    }

    acceptedLockFiles.push(candidate)
  }

  return {
    lockFiles: acceptedLockFiles,
    rootDir: acceptedLockFiles.length
      ? dirname(acceptedLockFiles[acceptedLockFiles.length - 1])
      : cwd,
    boundary,
  }
}

export function warnDuplicatedLockFiles(lockFiles: string[]) {
  if (lockFiles.length <= 1) return

  const config = process.env.TURBOPACK
    ? 'turbopack.root'
    : 'outputFileTracingRoot'
  const docs = process.env.TURBOPACK
    ? 'https://nextjs.org/docs/app/api-reference/config/next-config-js/turbopack#root-directory'
    : 'https://nextjs.org/docs/app/api-reference/config/next-config-js/output#caveats'

  const rootLockFile = lockFiles[lockFiles.length - 1]
  const additionalLockFiles = lockFiles
    .slice(0, -1)
    .map((str) => `\n   * ${str}`)
    .join('')

  Log.warnOnce(
    `Warning: Next.js inferred your workspace root, but it may not be correct.\n` +
      ` We detected multiple lockfiles and selected the directory of ${rootLockFile} as the root directory.\n` +
      ` To silence this warning, set \`${config}\` in your Next.js config, or consider ` +
      `removing one of the lockfiles if it's not needed.\n` +
      `   See ${docs} for more information.\n` +
      ` Detected additional lockfiles: ${additionalLockFiles}\n`
  )
}

export function warnRootBoundary({ boundary, root, type }: RootBoundary) {
  const config = process.env.TURBOPACK
    ? 'turbopack.root'
    : 'outputFileTracingRoot'
  const reason =
    type === 'repository'
      ? `it is outside the current Git repository (${boundary})`
      : `it would include your home directory (${boundary})`

  Log.warnOnce(
    `Warning: Next.js ignored a workspace marker in ${root} because ${reason}.\n` +
      ` To use this directory, set \`${config}\` in your Next.js config.\n`
  )
}
