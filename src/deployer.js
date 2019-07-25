
const utils = require('./utils')
const Redis = require('ioredis')
const net = require('net')
const redis = new Redis()

function pullRequestEvent (req) {
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
  let deployId
  if (checkSuite.pull_requests.length > 0) {
    deployId = utils.getIdFromPullRequest(req.body)
  } else {
    deployId = utils.getIdFromBranch(checkSuite.head_branch)
  }

  return deploy(deployId)
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

function deploy (deployId) {
  return redis.get(deployId)
    .then(currentPort => {
      if (currentPort === undefined) {
        return getAvailablePort()
          .then((port) => {
            // Create a new deployment
            console.log('DEPLOYED')
            redis.set(deployId, port)
          })
      }

      // We already have a deployment running so we should update that
      console.log('RE-DEPLOYED')
      return Promise.resolve()
    })
}

function removeDeployment (deployId) {
  redis.del(deployId)
  console.log('REMOVED DEPLOYMENT')
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
