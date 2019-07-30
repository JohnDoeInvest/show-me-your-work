
const utils = require('./utils')
const Redis = require('ioredis')
const net = require('net')
const childProcess = require('child_process')
const fs = require('fs')

const DEPLOY_PULL_REQUESTS = (process.env.DEPLOY_PULL_REQUESTS === 'true') || true
const DEPLOY_BRANCHES = (process.env.DEPLOY_BRANCHES === 'true') || false
// eslint-disable-next-line no-unused-vars
const BRANCH_BLACKLIST = process.env.BRANCH_BLACKLIST === undefined ? [] : process.env.BRANCH_BLACKLIST.split(',')
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN
const REDIS_HOST = process.env.REDIS_HOST || 'localhost'
const REDIS_PORT = process.env.REDIS_PORT || 6379

const redis = new Redis({
  host: REDIS_HOST,
  port: REDIS_PORT
})

function pullRequestEvent (req) {
  // TODO: When a PR is re-opened it would be nice if it was deployed again, the issues is that the
  // Check Suite doesn't run again. So we would have to do it on the re-open but also check that
  // all checks have been ran somehow.
  const deployId = utils.getIdFromPullRequest(req.body)
  if (req.body.action === 'closed') {
    return removeDeployment(deployId)
  } else {
    return Promise.resolve()
  }
}

function checkSuiteEvent (req) {
  if (req.body.action !== 'completed' || req.body.check_suite.head_branch === null) {
    return Promise.resolve()
  }

  const checkSuite = req.body.check_suite
  if (checkSuite.status === 'completed' && checkSuite.conclusion === 'success') {
    if (DEPLOY_PULL_REQUESTS && checkSuite.pull_requests.length > 0) {
      const pullRequest = checkSuite.pull_requests[0]
      const deployId = utils.getIdFromPullRequest(pullRequest)

      // Remove branch deployment when creating
      removeDeployment(utils.getIdFromBranch(checkSuite.head_branch))

      return deploy(deployId, req.body.repository, checkSuite.head_branch, checkSuite.head_sha)
    } else if (DEPLOY_BRANCHES) {
      // TODO: If branch A is pushed to the repository it will be checked. When branch B, with the
      // same commit at the head is pushed (or a already checked commit is the head) we will get
      // that check_suite, so instead of branch B we get branch A. The only way to get around this
      // would be to listen for a push and then wait for the check_run.

      /*
      const deployId = utils.getIdFromBranch(checkSuite.head_branch)
      if (BRANCH_BLACKLIST.includes(checkSuite.head_branch)) {
        return Promise.resolve()
      }

      return deploy(deployId, req.body.repository, checkSuite.head_branch, checkSuite.head_sha)
      */
      return Promise.resolve()
    }
  }

  return Promise.resolve()
}

function deleteEvent (req) {
  const deployId = (req.body.ref_type === 'tag')
    ? utils.getIdFromTag(req.body.ref)
    : utils.getIdFromBranch(req.body.ref)

  return removeDeployment(deployId)
}

function deploy (deployId, repository, branch, sha) {
  const url = repository.clone_url.replace('https://github.com', 'https://' + GITHUB_ACCESS_TOKEN + '@github.com')
  return redis.get(deployId)
    .then(currentPort => {
      if (currentPort === null) {
        return getAvailablePort()
          .then((port) => {
            // Create a new deployment
            console.log('STARTING DEPLOY - ' + deployId)
            redis.set(deployId, port)
            childProcess.execSync(`git clone --depth=50 --branch=${branch} ${url} deploys/${deployId}`)
            childProcess.execSync(`cd deploys/${deployId} && git checkout -qf ${sha} && npm ci`)

            return getConfig(deployId)
              .then(config => {
                childProcess.execSync(`cd deploys/${deployId} && ${config.pres}`)
                childProcess.execSync(`cd deploys/${deployId} && PORT=${port} ${config.envs} pm2 start ${config.startFile} --name frontend-${deployId}`)
                console.log('FINISHED DEPLOY - ' + deployId)
              })
          })
      }

      // We already have a deployment running so we should update that
      console.log('STARTING RE-DEPLOY - ' + deployId)
      childProcess.execSync(`cd deploys/${deployId} && git fetch`)
      childProcess.execSync(`cd deploys/${deployId} && git checkout -qf ${sha} && npm ci`)

      return getConfig(deployId)
        .then(config => {
          childProcess.execSync(`cd deploys/${deployId} && ${config.pres}`)
          childProcess.execSync(`cd deploys/${deployId} && PORT=${currentPort} ${config.envs} pm2 restart frontend-${deployId} --update-env`)
          console.log('FINISHED RE-DEPLOY - ' + deployId)
          return Promise.resolve()
        })
    })
}

function removeDeployment (deployId) {
  console.log('REMOVED DEPLOYMENT - ' + deployId)
  return redis.del(deployId).then(() => {
    childProcess.exec(`pm2 delete frontend-${deployId} && rm -r deploys/${deployId}`)
  })
}

function getConfig (deployId) {
  const hasConfig = fs.existsSync(`deploys/${deployId}/show-me-your-work.json`)
  if (!hasConfig) {
    return removeDeployment(deployId)
  }

  const config = JSON.parse(fs.readFileSync(`deploys/${deployId}/show-me-your-work.json`, 'utf-8'))
  config.envs = Object.entries(config.env).map(([key, val]) => `${key}=${val}`).join(' ')
  config.pres = config.pre.join(' && ')

  return Promise.resolve(config)
}

/**
 * Starts a server with the port 0 which makes the OS automatically assign a port to the server.
 * This means that the port was ("is") free on the OS. We get the port from the server and close
 * is again. We now have a port which is not used by anything on the system.
 */
function getAvailablePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.on('listening', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.listen(0)
  })
}

module.exports = {
  pullRequestEvent,
  checkSuiteEvent,
  deleteEvent
}
