
const utils = require('./utils')
const Redis = require('ioredis')
const net = require('net')
const redis = new Redis()
const childProcess = require('child_process')

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

function checkSuiteEvent (req) {
  if (req.body.action !== 'completed' || req.body.check_suite.head_branch === null) {
    return Promise.resolve()
  }

  const checkSuite = req.body.check_suite
  if (checkSuite.pull_requests.length > 0) {
    const pullRequest = checkSuite.pull_requests[0]
    const deployId = utils.getIdFromPullRequest(pullRequest)

    return deploy(deployId, req.body.repository, checkSuite.head_branch, checkSuite.head_sha)
  } else {
    // const deployId = utils.getIdFromBranch(checkSuite.head_branch)
    // Ignore branches for now, not sure how we should handle them
    return Promise.resolve()
  }
}

function pushEvent (req) {
  return Promise.resolve()
  /* const deployId = (req.body.head_commit === null)
    ? utils.getIdFromTag(req.body)
    : utils.getIdFromBranch(req.body)
  return deploy(deployId) */
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
            console.log('STARTING DEPLOY')
            redis.set(deployId, port)
            childProcess.execSync(`git clone --depth=50 --branch=${branch} ${url} deploys/${deployId}`)
            childProcess.execSync(`cd deploys/${deployId} && git checkout -qf ${sha} && npm install && npm run build:stage`)
            childProcess.execSync(`cd deploys/${deployId} && PORT=${port} NODE_ENV=stage pm2 start ./src/server --name frontend-${deployId} --env stage`)
            console.log('FINISHED DEPLOY')
            return Promise.resolve()
          })
      }

      // We already have a deployment running so we should update that
      console.log('STARTING RE-DEPLOY')
      childProcess.execSync(`cd deploys/${deployId} && git fetch`)
      childProcess.execSync(`cd deploys/${deployId} && git checkout -qf ${sha} && npm install && npm run build:stage`)
      childProcess.execSync(`cd deploys/${deployId} && PORT=${currentPort} NODE_ENV=stage pm2 restart frontend-${deployId}`)
      console.log('FINISHED RE-DEPLOY')
      return Promise.resolve()
    })
}

function removeDeployment (deployId) {
  console.log('REMOVED DEPLOYMENT')
  return redis.del(deployId).then(() => {
    childProcess.exec(`pm2 delete frontend-${deployId} && rm -r deploys/${deployId}`)
  })
}

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
  pushEvent,
  deleteEvent
}
