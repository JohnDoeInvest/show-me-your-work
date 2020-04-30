const utils = require('./utils/utils')
const redisUtils = require('./utils/redisUtils')
const redis = require('./redis')
const { BUILDING, REBUILDING, RUNNING } = require('./buildStatusState')
const childProcess = require('child_process')
const fs = require('fs')
const util = require('util')

const statAsync = util.promisify(fs.stat)

const DEPLOY_PULL_REQUESTS = (process.env.DEPLOY_PULL_REQUESTS === 'true') || true
const DEPLOY_BRANCHES = (process.env.DEPLOY_BRANCHES === 'true') || false
// eslint-disable-next-line no-unused-vars
const BRANCH_BLACKLIST = process.env.BRANCH_BLACKLIST === undefined ? [] : process.env.BRANCH_BLACKLIST.split(',')
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN
const PM2_NAME_PREFIX = process.env.PM2_NAME_PREFIX || 'default'

// This contains signal
const runningTasks = {}

function execAsync (deployId, command, options) {
  return new Promise(function (resolve, reject) {
    const child = childProcess.exec(command, options, (error, stdout, stderr) => {
      if (runningTasks[deployId] === 'ABORTED') {
        reject(error)
        return
      }
      delete runningTasks[deployId]
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
    runningTasks[deployId] = child
  })
}

async function checkStatus () {
  const keys = await redisUtils.scanKeys(redis, 0, 'MATCH', '*-STATUS')
  for (const key of keys) {
    const info = await redis.hgetall(key)
    switch (info.status) {
      case BUILDING:
      case REBUILDING:
        deploy(key.replace('-STATUS', ''), info.cloneUrl, info.branch, info.sha)
        break
      case RUNNING:
        break
    }
  }
}

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
      return removeDeployment(utils.getIdFromBranch(checkSuite.head_branch))
        .then(() => deploy(deployId, req.body.repository.clone_url, checkSuite.head_branch, checkSuite.head_sha))
    } else if (DEPLOY_BRANCHES) {
      // We can't be sure that this is the correct branch, since if the SHA has been built on
      // another branch before we will get that branch name
      const deployId = utils.getIdFromBranch(checkSuite.head_branch)
      if (BRANCH_BLACKLIST.includes(checkSuite.head_branch)) {
        return Promise.resolve()
      }

      return deploy(deployId, req.body.repository.clone_url, checkSuite.head_branch, checkSuite.head_sha)
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

async function deploy (deployId, cloneUrl, branch, sha) {
  if (runningTasks[deployId] !== undefined) {
    const task = runningTasks[deployId]
    runningTasks[deployId] = 'ABORTED'
    task.kill()
  }

  try {
    const url = cloneUrl.replace('https://github.com', 'https://' + GITHUB_ACCESS_TOKEN + '@github.com')
    const deployPath = `deploys/${deployId}`

    const currentPort = await redis.get(deployId)
    let deployPathStat
    try {
      deployPathStat = await statAsync(deployPath)
    } catch (e) {}

    if (currentPort === null || deployPathStat === undefined) {
      // If we have no port but still a deployed path we should remove the entire thing.
      if (deployPathStat !== undefined) {
        await removeDeployment(deployId)
      }

      const port = await utils.getAvailablePort()
      console.log(`DEPLOY - ${deployId}: Starting`)
      await updateStatus(deployId, BUILDING, cloneUrl, branch, sha)
      await execAsync(deployId, `git clone --depth=50 --branch=${branch} ${url} ${deployPath}`)
      console.log(`DEPLOY - ${deployId}: Installing dependencies`)
      await execAsync(deployId, `cd ${deployPath} && git checkout -qf ${sha} && npm ci`)
      console.log(`DEPLOY - ${deployId}: Running pre-start commands`)

      const config = await getConfig(deployId)
      const name = getPm2Name(deployId)
      await execAsync(deployId, `cd ${deployPath} && ${config.pres}`)
      console.log(`DEPLOY - ${deployId}: Starting application`)
      await execAsync(deployId, `cd ${deployPath} && pm2 start ${config.startFile} --name ${name}`, {
        env: {
          ...process.env,
          ...config.env,
          PORT: port
        }
      })
      await redis.set(deployId, port)
      console.log(`DEPLOY - ${deployId}: Finished`)
      return updateStatus(deployId, RUNNING, cloneUrl, branch, sha)
    }

    // We already have a deployment running so we should update that
    console.log(`RE-DEPLOY - ${deployId}: Starting`)
    await updateStatus(deployId, REBUILDING, cloneUrl, branch, sha)
    await execAsync(deployId, `cd ${deployPath} && git fetch`)
    console.log(`RE-DEPLOY - ${deployId}: Installing dependencies`)
    await execAsync(deployId, `cd ${deployPath} && git checkout -qf ${sha} && npm ci`)
    console.log(`RE-DEPLOY - ${deployId}: Running pre-start commands`)
    const config = await getConfig(deployId)
    const name = getPm2Name(deployId)
    await execAsync(deployId, `cd ${deployPath} && ${config.pres}`)

    console.log(`RE-DEPLOY - ${deployId}: Starting application`)
    await execAsync(deployId, `cd ${deployPath} && pm2 restart ${name} --update-env`, {
      env: {
        ...process.env,
        ...config.env,
        PORT: currentPort
      }
    })
    console.log(`RE-DEPLOY - ${deployId}: Finished`)
    return updateStatus(deployId, RUNNING, cloneUrl, branch, sha)
  } catch (e) {
    console.log(`${deployId}: Aborted`)
    return Promise.resolve()
  }
}

function getConfig (deployId) {
  const hasConfig = fs.existsSync(`deploys/${deployId}/show-me-your-work.json`)
  if (!hasConfig) {
    return removeDeployment(deployId)
  }

  const config = JSON.parse(fs.readFileSync(`deploys/${deployId}/show-me-your-work.json`, 'utf-8'))
  config.pres = config.pre.join(' && ')

  return Promise.resolve(config)
}

function removeDeployment (deployId) {
  const isWin = process.platform === 'win32'
  if (runningTasks[deployId] !== undefined) {
    const task = runningTasks[deployId]
    runningTasks[deployId] = 'ABORTED'

    if (isWin) { // process.platform was undefined for me, but this works
      childProcess.execSync(`taskkill /F /T /PID ${task.pid}`) // windows specific
    } else {
      task.kill('SIGINT')
    }

    return new Promise((resolve, reject) => {
      task.on('exit', () => {
        executeRemoveDeployment(deployId)
          .then(resolve)
          .catch(reject)
      })
    })
  } else {
    return executeRemoveDeployment(deployId)
  }
}

function executeRemoveDeployment (deployId) {
  const statusId = deployId + '-STATUS'
  delete runningTasks[deployId]
  console.log(deployId + ': Removing deployment')
  const isWin = process.platform === 'win32'
  const name = getPm2Name(deployId)

  return redis.del(deployId, statusId)
    .then(() => {
      return execAsync(deployId, `pm2 delete ${name}`)
        .catch(() => Promise.resolve())
    })
    .then(() => execAsync(deployId, isWin ? `rmdir deploys\\${deployId} /s /q` : `rm -r deploys/${deployId}`))
    .then(() => console.log(deployId + ': Removed deployment'))
    .catch(e => {
      console.log(e.message)
      Promise.resolve()
    })
}

function getPm2Name (deployId) {
  return PM2_NAME_PREFIX + '-' + deployId
}

async function updateStatus (deployId, status, cloneUrl, branch, sha) {
  const statusId = deployId + '-STATUS'

  return redis.hmset(statusId, {
    status,
    cloneUrl,
    branch,
    sha
  })
}

module.exports = {
  pullRequestEvent,
  checkRunEvent,
  deleteEvent,
  checkStatus
}
