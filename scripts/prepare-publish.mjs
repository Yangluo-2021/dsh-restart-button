/**
 * Point this package at a real npm scope and a real GitHub repository.
 *
 * Three files have to agree or the plugin breaks in a way that is hard to read
 * from the error: `package.json` names the package, `cordis.patch.yml` imports
 * that package by name (a stale name there means "cannot find module" at boot),
 * and the README tells people what to type. This script is the one place that
 * changes all three.
 *
 * Run:
 *   node scripts/prepare-publish.mjs --npm-user yourname --github-user yourname
 *   node scripts/prepare-publish.mjs --npm-user yourname --github-user yourname --dry-run
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PACKAGE = 'dsh-restart-button'
const REGISTRY = 'https://registry.npmjs.org'

function usage(message) {
  if (message !== undefined) console.error(`error: ${message}\n`)
  console.error(`usage: node scripts/prepare-publish.mjs --npm-user <name> --github-user <name> [options]

  --npm-user      npm 账号名（会作为 scope：@name/${PACKAGE}）。必须小写。
  --github-user   GitHub 账号名，用来填 repository / homepage / bugs。
  --repo          仓库名，默认 ${PACKAGE}
  --author        作者署名，默认与 --npm-user 相同
  --dry-run       只打印将要做的改动，不写文件`)
  process.exit(1)
}

function parseArgs(argv) {
  const options = { repo: PACKAGE, dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) usage(`${flag} 需要一个值`)
      i += 1
      return value
    }
    if (flag === '--npm-user') options.npmUser = next()
    else if (flag === '--github-user') options.githubUser = next()
    else if (flag === '--repo') options.repo = next()
    else if (flag === '--author') options.author = next()
    else if (flag === '--dry-run') options.dryRun = true
    else if (flag === '--help' || flag === '-h') usage()
    else usage(`不认识的参数 ${flag}`)
  }
  if (options.npmUser === undefined) usage('缺少 --npm-user')
  if (options.githubUser === undefined) usage('缺少 --github-user')

  // npm scopes are lowercase only; anything else is rejected by the registry
  // after a full upload attempt, which is a slow way to learn this.
  if (!/^[a-z0-9][a-z0-9._-]{0,213}$/.test(options.npmUser)) {
    usage(`--npm-user "${options.npmUser}" 不是合法的 npm 用户名（只能小写字母、数字、. _ -）`)
  }
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(options.githubUser)) {
    usage(`--github-user "${options.githubUser}" 不是合法的 GitHub 用户名`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(options.repo)) usage(`--repo "${options.repo}" 不是合法的仓库名`)

  options.packageName = `@${options.npmUser}/${PACKAGE}`
  options.author = options.author ?? options.npmUser
  return options
}

function readText(file) {
  return readFileSync(join(ROOT, file), 'utf8')
}

function writeText(file, text, dryRun, log) {
  if (dryRun) return
  writeFileSync(join(ROOT, file), text)
  log.push(file)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const changed = []
  const note = (line) => console.log(`  ${line}`)

  // ---- package.json -------------------------------------------------------
  const manifestPath = 'package.json'
  const manifest = JSON.parse(readText(manifestPath))
  const repoUrl = `https://github.com/${options.githubUser}/${options.repo}`

  manifest.name = options.packageName
  manifest.repository = { type: 'git', url: `git+${repoUrl}.git` }
  manifest.homepage = `${repoUrl}#readme`
  manifest.bugs = { url: `${repoUrl}/issues` }
  manifest.author = options.author
  // Pin the registry so the local npmmirror default cannot receive a publish,
  // and declare public access so a scoped package is not rejected as private.
  manifest.publishConfig = { access: 'public', registry: REGISTRY }

  const order = ['name', 'description', 'version', 'type', 'main', 'license', 'author', 'os', 'engines',
    'keywords', 'repository', 'homepage', 'bugs', 'publishConfig', 'scripts', 'files', 'dsh', 'exports']
  const sorted = {}
  for (const key of order) if (key in manifest) sorted[key] = manifest[key]
  for (const key of Object.keys(manifest)) if (!(key in sorted)) sorted[key] = manifest[key]

  writeText(manifestPath, `${JSON.stringify(sorted, null, 2)}\n`, options.dryRun, changed)
  console.log('\npackage.json')
  note(`name      ${options.packageName}`)
  note(`repository ${repoUrl}`)
  note(`publish    ${REGISTRY} · access=public`)

  // ---- cordis.patch.yml ---------------------------------------------------
  // `name` here is the module specifier the Loader imports. Leaving the bare
  // name behind means the plugin entry resolves to a package that no longer
  // exists under that name, and DSH fails at boot with "cannot find module".
  const patchPath = 'cordis.patch.yml'
  const patch = readText(patchPath)
  const patchNext = patch.replace(/^(\s*name:\s*)'[^']*'$/m, `$1'${options.packageName}'`)
  if (patchNext === patch && !patch.includes(`'${options.packageName}'`)) {
    usage('cordis.patch.yml 里没找到要替换的 name 行，请手动确认它的格式')
  }
  writeText(patchPath, patchNext, options.dryRun, changed)
  console.log('\ncordis.patch.yml')
  for (const line of patchNext.split('\n')) if (line.trim().startsWith('name:')) note(line.trim())

  // ---- README -------------------------------------------------------------
  // The placeholder keeps the document readable before the scope is known.
  const readmePath = 'README.md'
  const readme = readText(readmePath)
  const readmeNext = readme
    .replaceAll('@NPM_USER/', `@${options.npmUser}/`)
    .replace(new RegExp(`@[a-z0-9._-]+/${PACKAGE}`, 'g'), `@${options.npmUser}/${PACKAGE}`)
  writeText(readmePath, readmeNext, options.dryRun, changed)
  console.log('\nREADME.md')
  note(`安装命令 → dsh plugin --profile desktop add ${options.packageName}`)

  console.log(options.dryRun ? '\n(dry run，没有写文件)' : `\n已更新: ${changed.join(', ')}`)

  console.log(`\n下一步:
  npm login --registry=${REGISTRY}
  npm publish
  git init && git add -A && git commit -m "init"
  gh repo create ${options.repo} --public --source=. --push`)
}

main()
