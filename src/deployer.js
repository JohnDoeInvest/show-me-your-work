const utils = require('./utils/utils')
const redisUtils = require('./utils/redisUtils')
const redis = require('./redis')
const { BUILDING, REBUILDING, RUNNING } = require('./buildStatusState')
const childProcess = require('child_process')
const fs = require('fs')
const getPort = require('get-port')
const util = require('util')
const configs = require('../config.json')

const statAsync = util.promisify(fs.stat)
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN

/** This contains the following
 *  {
 *    currentSignal: Signal,
 *    status: 'ABORTED' | 'RUNNING'
 *  }
 */
const runningTasks = {}

function execAsync (deployId, command, options) {
  return new Promise(function (resolve, reject) {
    if (runningTasks[deployId] !== undefined && runningTasks[deployId].status === 'RUNNING') {
      const child = childProcess.exec(command, options, (error, stdout, stderr) => {
        if (runningTasks[deployId].status === 'ABORTED') {
          reject(error)
          return
        }

        if (error) {
          reject(error)
          return
        }

        resolve()
      })
      runningTasks[deployId].currentSignal = child
    } else {
      if (runningTasks[deployId] !== undefined && runningTasks[deployId].status === 'ABORTED') {
        reject(new Error('Aborted for unknown reason'))
      }
      console.warn('Trying to start child process without a running task')
    }
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

function getConfigForPayload (eventType, payload) {
  const matchingConfigs = []
  const branch = getBranchFromPayload(eventType, payload)
  for (const config of configs) {
    if (payload.repository.full_name === config.repository) {
      if (config.branch !== undefined && config.branch !== branch) {
        continue
      }

      if (config.branchBlackList !== undefined && config.branchBlackList.includes(branch)) {
        continue
      }

      matchingConfigs.push(config)
    }
  }

  if (matchingConfigs.length === 0) {
    throw new Error('No matching configs for: ' + JSON.stringify({
      eventType,
      branch,
      repository: payload.repository.full_name
    }))
  }

  if (matchingConfigs.length > 1) {
    console.warn('Multiple matching configs for: ' + JSON.stringify({
      eventType,
      branch,
      repository: payload.repository.full_name
    }) + ' selecting first found')
  }

  return matchingConfigs[0]
}

function getBranchFromPayload (eventType, payload) {
  switch (eventType) {
    case 'pull_request':
      return payload.pull_request.head.ref
    case 'check_run':
      return payload.check_run.check_suite.head_branch
    case 'delete':
      return payload.ref.replace('refs/heads/') // This will always return as "refs/heads/BRANCH"
  }
}

function pullRequestEvent (eventType, payload) {
  // TODO: When a PR is re-opened it would be nice if it was deployed again, the issues is that the
  // Check Suite doesn't run again. So we would have to do it on the re-open but also check that
  // all checks have been ran somehow.
  const config = getConfigForPayload(eventType, payload)
  const deployId = utils.getIdFromPullRequest(config, payload)
  if (payload.action === 'closed') {
    return removeDeployment(deployId)
  } else {
    return Promise.resolve()
  }
}

async function checkRunEvent (eventType, payload) {
  if (payload.action !== 'completed' || payload.check_run.check_suite.head_branch === null) {
    return Promise.resolve()
  }

  const config = getConfigForPayload(eventType, payload)
  const checkSuite = payload.check_run.check_suite
  if (checkSuite.status === 'completed' && checkSuite.conclusion === 'success') {
    if (config.deployPullRequest === true && checkSuite.pull_requests.length > 0) {
      const pullRequest = checkSuite.pull_requests[0]
      const deployId = utils.getIdFromPullRequest(config, pullRequest)

      // Remove branch deployment when creating
      if (!config.staticBranches.includes(checkSuite.head_branch)) {
        await removeDeployment(utils.getIdFromBranch(config, checkSuite.head_branch))
      }

      return deploy(config, deployId, payload.repository.clone_url, checkSuite.head_branch, checkSuite.head_sha)
    } else if (config.deployBranches === true) {
      // We can't be sure that this is the correct branch, since if the SHA has been built on
      // another branch before we will get that branch name
      const deployId = utils.getIdFromBranch(config, checkSuite.head_branch)
      return deploy(config, deployId, payload.repository.clone_url, checkSuite.head_branch, checkSuite.head_sha)
    }
  }

  return Promise.resolve()
}

function deleteEvent (eventType, payload) {
  if (payload.ref_type === 'tag') {
    return Promise.resolve()
  }
  const config = getConfigForPayload(eventType, payload)
  const deployId = utils.getIdFromBranch(config, payload.ref)
  return removeDeployment(deployId)
}

async function deploy (config, deployId, cloneUrl, branch, sha) {
  if (runningTasks[deployId] !== undefined && runningTasks[deployId].status === 'RUNNING') {
    const signal = runningTasks[deployId].currentSignal
    runningTasks[deployId].status = 'ABORTED'
    signal.kill()
  }

  runningTasks[deployId] = { status: 'RUNNING' }
  try {
    const url = cloneUrl.replace('https://github.com', 'https://' + GITHUB_ACCESS_TOKEN + '@github.com')
    const deployPath = `deploys/${deployId}`
    const name = deployId

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

      const allowedPorts = config.port.includes(':') ? getPort.makeRange(...config.port.split(':').map(s => Number.parseInt(s))) : Number.parseInt(config.port)
      const port = await getPort({ port: allowedPorts })

      if (Array.isArray(allowedPorts) && (port < allowedPorts[0] || port > allowedPorts[allowedPorts.length - 1])) {
        throw new Error('Could not find available port for config: ' + JSON.stringify(config))
      } else if (!Array.isArray(allowedPorts) && port !== allowedPorts) {
        throw new Error('Could not find available port for config: ' + JSON.stringify(config))
      }

      console.log(`DEPLOY - ${deployId}: Starting`)
      await updateStatus(deployId, BUILDING, cloneUrl, branch, sha)
      await execAsync(deployId, `git clone --depth=50 --branch=${branch} ${url} ${deployPath}`)
      console.log(`DEPLOY - ${deployId}: Installing dependencies`)
      await execAsync(deployId, `cd ${deployPath} && git checkout -qf ${sha}`)
      console.log(`DEPLOY - ${deployId}: Running pre-start commands`)

      for (const pre of config.pre) {
        await execAsync(deployId, `cd ${deployPath} && ${pre}`)
      }
      console.log(`DEPLOY - ${deployId}: Starting application`)
      await execAsync(deployId, `cd ${deployPath} && pm2 start --name ${name} ${config.startFile}`, {
        env: {
          ...process.env,
          ...utils.prepareEnvs(config.env, port),
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
    await execAsync(deployId, `cd ${deployPath} && git checkout -qf ${sha}`)
    console.log(`RE-DEPLOY - ${deployId}: Running pre-start commands`)

    for (const pre of config.pre) {
      await execAsync(deployId, `cd ${deployPath} && ${pre}`)
    }

    console.log(`RE-DEPLOY - ${deployId}: Starting application`)
    await execAsync(deployId, `cd ${deployPath} && pm2 restart ${name} --update-env`, {
      env: {
        ...process.env,
        ...utils.prepareEnvs(config.env, currentPort),
        PORT: currentPort
      }
    })
    console.log(`RE-DEPLOY - ${deployId}: Finished`)
    await updateStatus(deployId, RUNNING, cloneUrl, branch, sha)
    delete runningTasks[deployId]
    return Promise.resolve()
  } catch (e) {
    console.log(`${deployId}: Aborted`, e)
    delete runningTasks[deployId]
    return Promise.resolve()
  }
}

function removeDeployment (deployId) {
  const isWin = process.platform === 'win32'
  if (runningTasks[deployId] !== undefined && runningTasks[deployId].status === 'RUNNING') {
    const signal = runningTasks[deployId].currentSignal
    runningTasks[deployId].status = 'ABORTED'

    runningTasks[deployId] = { status: 'RUNNING' }
    if (isWin) { // process.platform was undefined for me, but this works
      childProcess.execSync(`taskkill /F /T /PID ${signal.pid}`) // windows specific
    } else {
      signal.kill('SIGINT')
    }

    return new Promise((resolve, reject) => {
      signal.on('exit', () => {
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
  console.log(deployId + ': Removing deployment')
  const isWin = process.platform === 'win32'

  runningTasks[deployId] = { status: 'RUNNING' }
  return redis.del(deployId, statusId)
    .then(() => {
      return execAsync(deployId, `pm2 delete ${deployId}`)
        .catch(() => Promise.resolve())
    })
    .then(() => execAsync(deployId, isWin ? `rmdir deploys\\${deployId} /s /q` : `rm -r deploys/${deployId}`))
    .then(() => console.log(deployId + ': Removed deployment'))
    .then(() => delete runningTasks[deployId])
    .catch(e => {
      console.log(e.message)
      delete runningTasks[deployId]
      Promise.resolve()
    })
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
