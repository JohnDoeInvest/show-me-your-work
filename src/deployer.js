const utils = require('./utils/utils')
const redis = require('./redis')
const { BUILDING, REBUILDING, RUNNING } = require('./buildStatusState')
const net = require('net')
const childProcess = require('child_process')
const fs = require('fs')
const util = require('util')

const execAsync = util.promisify(childProcess.exec)

const DEPLOY_PULL_REQUESTS = (process.env.DEPLOY_PULL_REQUESTS === 'true') || true
const DEPLOY_BRANCHES = (process.env.DEPLOY_BRANCHES === 'true') || false
// eslint-disable-next-line no-unused-vars
const BRANCH_BLACKLIST = process.env.BRANCH_BLACKLIST === undefined ? [] : process.env.BRANCH_BLACKLIST.split(',')
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN

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
function checkRunEvent (req) {
  if (req.body.action !== 'completed' || req.body.check_run.check_suite.head_branch === null) {
    return Promise.resolve()
  }

  const checkSuite = req.body.check_run.check_suite
  if (checkSuite.status === 'completed' && checkSuite.conclusion === 'success') {
    if (DEPLOY_PULL_REQUESTS && checkSuite.pull_requests.length > 0) {
      const pullRequest = checkSuite.pull_requests[0]
      const deployId = utils.getIdFromPullRequest(pullRequest)

      // Remove branch deployment when creating
      removeDeployment(utils.getIdFromBranch(checkSuite.head_branch))

      return deploy(deployId, req.body.repository, checkSuite.head_branch, checkSuite.head_sha)
    } else if (DEPLOY_BRANCHES) {
      // We can't be sure that this is the correct branch, since if the SHA has been built on
      // another branch before we will get that branch name
      const deployId = utils.getIdFromBranch(checkSuite.head_branch)
      if (BRANCH_BLACKLIST.includes(checkSuite.head_branch)) {
        return Promise.resolve()
      }

      return deploy(deployId, req.body.repository, checkSuite.head_branch, checkSuite.head_sha)
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
  const statusId = deployId + '-STATUS'
  const url = repository.clone_url.replace('https://github.com', 'https://' + GITHUB_ACCESS_TOKEN + '@github.com')
  return redis.get(deployId)
    .then(currentPort => {
      if (currentPort === null) {
        return getAvailablePort()
          .then((port) => {
            // Create a new deployment
            console.log('STARTING DEPLOY - ' + deployId)
            redis.set(deployId, port)
            redis.set(statusId, BUILDING)
            execAsync(`git clone --depth=50 --branch=${branch} ${url} deploys/${deployId}`)
              .then(() => execAsync(`cd deploys/${deployId} && git checkout -qf ${sha} && npm ci`))
              .then(() => getConfig(deployId))
              .then(config => {
                return execAsync(`cd deploys/${deployId} && ${config.pres}`)
                  .then(() => execAsync(`cd deploys/${deployId} && PORT=${port} ${config.envs} pm2 start ${config.startFile} --name frontend-${deployId}`))
                  .then(() => {
                    console.log('FINISHED DEPLOY - ' + deployId)
                    return redis.set(statusId, RUNNING)
                  })
              })
          })
      }

      // We already have a deployment running so we should update that
      console.log('STARTING RE-DEPLOY - ' + deployId)
      return redis.set(statusId, REBUILDING)
        .then(() => execAsync(`cd deploys/${deployId} && git fetch`))
        .then(() => execAsync(`cd deploys/${deployId} && git checkout -qf ${sha} && npm ci`))
        .then(() => getConfig(deployId))
        .then(config => {
          return execAsync(`cd deploys/${deployId} && ${config.pres}`)
            .then(() => execAsync(`cd deploys/${deployId} && PORT=${currentPort} ${config.envs} pm2 restart frontend-${deployId} --update-env`))
            .then(() => {
              console.log('FINISHED RE-DEPLOY - ' + deployId)
              return redis.set(statusId, RUNNING)
            })
        })
    })
}

function removeDeployment (deployId) {
  console.log('REMOVED DEPLOYMENT - ' + deployId)
  return redis.del(deployId, deployId + '-STATUS')
    .then(() => execAsync(`pm2 delete frontend-${deployId} && rm -r deploys/${deployId}`))
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
  checkRunEvent,
  deleteEvent
}
