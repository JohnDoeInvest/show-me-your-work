const utils = require('./utils/utils')
const redisUtils = require('./utils/redisUtils')
const redis = require('./redis')
const { BUILDING, REBUILDING, RUNNING } = require('./buildStatusState')
const fs = require('fs')
const path = require('path')
const util = require('util')
const configUtils = require('./utils/config')
const pm2 = require('pm2')
const fetch = require('node-fetch').default

const statAsync = util.promisify(fs.stat)
const rmDirAsync = util.promisify(fs.rmdir)
const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN

/**
 * Earlier implementations tried to be efficient about what was being built/removed/started etc. by
 * stopping processes. This never really worked since there seems to be to many edge cases. Moving
 * away from this lead me to "just" a queue.
 *
 * The queue is in Redis. This should allow Node to be smart about async tasks and us to not have to
 * worry about tasks interfering. The 0:th item in the queue is always the currently running one.
 */

// Command types
const COMMAND_DEPLOY = 'DEPLOY'
const COMMAND_REMOVE = 'REMOVE'

const QUEUE_KEY = 'job_queue'

// Start handling the queue
redis.monitor().then(monitor => handleQueue(monitor))

async function handleQueue (monitor) {
  let job = await redis.lindex(QUEUE_KEY, 0)

  /* TODO: Handle more than one job at the time.
   *
   * I looked at using something like https://github.com/bee-queue/bee-queue since it already does
   * what we want. We might still need some custom logic for some edge cases (see below)
   *
   * Remember edge cases like: [DEPLOY_BRANCH_A, REMOVE_BRANCH_A, DEPLOY_PR_OF_BRANCH_A] (Take jobs
   *   from left to right)
   *
   * If we run a simple LIFO and process this concurrently we would try to deploy and remove branch
   * A at the same time. So we would have to make sure that this can no happen. Even if we clear the
   * jobs with the same deployId when adding a job we might already be running the deploy and start
   * out remove while the deploy is running. Using our own queue would probably allow us to handle
   * these things, but another queue system might be a bit harder. If we use Bee-Queue we can use
   * something like:
   *
   * queue.getJobs('active', { start: 0, end: NUMBER_OF_CONCURRENT }).then(jobs => {
   *   // We need to delay our current job if another job is active with the same deployId
   * })
   *
   * And to remove the jobs which are currently waiting with the same deployId we can do:
   *
   * // If we can have more than 100 jobs I'd be surprised
   * queue.getJobs('waiting', { start: 0, end: 100 }).then(jobs => {
   *   // We should remove all of the jobs that match the deployId and after this we
   *   // can add the new job.
   * })
   */
  while (true) {
    if (job === null) {
      await pushedJob(monitor)
      job = await redis.lindex(QUEUE_KEY, 0)
    }

    const jobData = JSON.parse(job)
    await runCommand(jobData)
    await redis.lpop(QUEUE_KEY)
    job = await redis.lindex(QUEUE_KEY, 0)
  }
}

// Wait for RPUSH to the QUEUE_KEY
function pushedJob (monitor) {
  return new Promise((resolve, reject) => {
    monitor.on('monitor', (time, args, source, database) => {
      const command = args[0].toLowerCase()
      const key = args[1]
      if (command === 'rpush' && key === QUEUE_KEY) {
        resolve()
      }
    })
  })
}

function runCommand ({ commandType, deployId, config, deployData }) {
  if (commandType === COMMAND_DEPLOY) {
    return deploy(config, deployId, deployData.cloneUrl, deployData.branch, deployData.sha)
  } else if (commandType === COMMAND_REMOVE) {
    return removeDeployment(deployId, config)
  }
}

async function addToQueue (commandType, deployId, config, deployData) {
  // TODO: Be smarter about what is put in the queue. If we already have a task (not at index 0)
  // which handles the same deployId, we should probably replace it.
  const queue = await redis.lrange(QUEUE_KEY, 0, -1)
  if (queue !== null) {
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i]
      const job = JSON.parse(item)
      if (job.deployId === deployId && i !== 0) {
        await redis.lrem(QUEUE_KEY, 1, item)
      }
    }
  }
  await redis.rpush(QUEUE_KEY, JSON.stringify({ commandType, deployId, config, deployData }))
}

async function checkStatus () {
  const keys = await redisUtils.scanKeys(redis, 0, 'MATCH', '*-STATUS')
  for (const key of keys) {
    const info = await redis.hgetall(key)
    switch (info.status) {
      case BUILDING:
      case REBUILDING:
        addToQueue(COMMAND_DEPLOY, key.replace('-STATUS', ''), configUtils.getConfigForStatus(info), info)
        break
      case RUNNING:
        break
    }
  }
}

function pullRequestEvent (eventType, payload) {
  // TODO: When a PR is re-opened it would be nice if it was deployed again, the issues is that the
  // Check Suite doesn't run again. So we would have to do it on the re-open but also check that
  // all checks have been ran somehow.
  const config = configUtils.getConfigForPayload(eventType, payload)
  const deployId = utils.getIdFromPullRequest(config, payload)
  if (payload.action === 'closed') {
    return addToQueue(COMMAND_REMOVE, deployId, config)
  } else {
    return Promise.resolve()
  }
}

async function pushEvent (eventType, payload) {
  // Make sure that only branches are used
  if (!payload.ref.includes('refs/heads')) {
    return
  }
  const branch = configUtils.getBranchFromPayload(eventType, payload)
  const config = configUtils.getConfigForPayload(eventType, payload)
  if (config.ignoreCheck) {
    // We can't be sure that this is the correct branch, since if the SHA has been built on
    // another branch before we will get that branch name
    const deployId = utils.getIdFromBranch(config, branch)
    addToQueue(COMMAND_DEPLOY, deployId, config, { cloneUrl: payload.repository.clone_url, branch: branch, sha: payload.after })
  }

  return Promise.resolve()
}

async function checkRunEvent (eventType, payload) {
  const branch = configUtils.getCheckRunBranch(payload)
  if (payload.action !== 'completed') {
    return Promise.resolve()
  }

  const config = configUtils.getConfigForPayload(eventType, payload)
  const checkSuite = payload.check_run.check_suite
  if (checkSuite.status === 'completed' && checkSuite.conclusion === 'success') {
    if (config.deployPullRequest === true && checkSuite.pull_requests.length > 0) {
      const pullRequest = checkSuite.pull_requests[0]

      if (pullRequest) {
        const prURL = pullRequest.url.replace('https://api.github.com', 'https://' + GITHUB_ACCESS_TOKEN + '@api.github.com')
        const prRes = await fetch(prURL)
        if (prRes.ok) {
          const pr = await prRes.json()
          if (pr.state !== 'open') {
            return
          }
        }
      }

      const deployId = utils.getIdFromPullRequest(config, pullRequest)

      // Remove branch deployment when creating
      if (!config.staticBranches.includes(branch)) {
        addToQueue(COMMAND_REMOVE, utils.getIdFromBranch(config, branch), config)
      }

      addToQueue(COMMAND_DEPLOY, deployId, config, { cloneUrl: payload.repository.clone_url, branch: branch, sha: checkSuite.head_sha })
    } else if (config.deployBranches === true) {
      // We can't be sure that this is the correct branch, since if the SHA has been built on
      // another branch before we will get that branch name
      const deployId = utils.getIdFromBranch(config, branch)
      addToQueue(COMMAND_DEPLOY, deployId, config, { cloneUrl: payload.repository.clone_url, branch: branch, sha: checkSuite.head_sha })
    }
  }

  return Promise.resolve()
}

function deleteEvent (eventType, payload) {
  if (payload.ref_type === 'tag') {
    return Promise.resolve()
  }
  const config = configUtils.getConfigForPayload(eventType, payload)
  const deployId = utils.getIdFromBranch(config, payload.ref)
  return addToQueue(COMMAND_REMOVE, deployId, config)
}

async function deploy (config, deployId, cloneUrl, branch, sha) {
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
        await removeDeployment(deployId, config)
      }

      console.log(`DEPLOY - ${deployId}: Starting`)
      await updateStatus(deployId, BUILDING, cloneUrl, branch, sha)
      await utils.execAsync(`git clone --depth=50 --branch=${branch} ${url} ${deployPath}`)
      console.log(`DEPLOY - ${deployId}: Installing dependencies`)
      await utils.execAsync(`cd ${deployPath} && git checkout -qf ${sha}`)
      console.log(`DEPLOY - ${deployId}: Running pre-start commands`)

      for (const pre of config.pre) {
        await utils.execAsync(`cd ${deployPath} && ${pre}`)
      }

      const port = await configUtils.getAvailablePort(config)
      const addPorts = []
      // eslint-disable-next-line no-unused-vars
      for (const s of config.additionalServers) {
        addPorts.push(await configUtils.getAvailablePort(config, [port, ...addPorts]))
      }

      const additionalData = config.additionalServers.map((s, i) => {
        const addDeployId = getDeploymentId(deployId, s)
        return {
          deployId: addDeployId,
          port: addPorts[i],
          env: {
            ...s.env,
            [s.portEnv]: addPorts[i],
            [s.baseUrlEnv]: 'https://' + deployId + '.' + config.host
          }
        }
      })
      const additionalEnv = additionalData.reduce((a, v) => ({ ...a, ...v.env }), {})
      console.log(`DEPLOY - ${deployId}: Starting application`)
      const [script, args] = config.startFile.split('--').map(s => s.trim())
      await execPM2('start', {
        name,
        script,
        args,
        cwd: deployPath,
        env: {
          ...utils.prepareEnvs(config, port),
          ...additionalEnv,
          PORT: port,
          BASE_URL: 'https://' + deployId + '.' + config.host
        }
      })

      await redis.set(deployId, port)
      for (const data of additionalData) {
        await redis.set(data.deployId, data.port)
      }
      console.log(`DEPLOY - ${deployId}: Finished`)
      return updateStatus(deployId, RUNNING, cloneUrl, branch, sha)
    }

    // We already have a deployment running so we should update that
    console.log(`RE-DEPLOY - ${deployId}: Starting`)
    await updateStatus(deployId, REBUILDING, cloneUrl, branch, sha)
    await utils.execAsync(`cd ${deployPath} && git fetch`)
    console.log(`RE-DEPLOY - ${deployId}: Installing dependencies`)
    await utils.execAsync(`cd ${deployPath} && git checkout -qf ${sha}`)
    console.log(`RE-DEPLOY - ${deployId}: Running pre-start commands`)

    for (const pre of config.pre) {
      await utils.execAsync(`cd ${deployPath} && ${pre}`)
    }

    const usedAddPorts = []
    for (const s of config.additionalServers) {
      const currentPort = await redis.get(getDeploymentId(deployId, s))
      usedAddPorts.push(currentPort || (await configUtils.getAvailablePort(config, [currentPort, ...usedAddPorts])))
    }

    const additionalData = config.additionalServers.map((s, i) => {
      const addDeployId = getDeploymentId(deployId, s)
      const port = usedAddPorts[i]
      return {
        deployId: addDeployId,
        port,
        env: {
          ...s.env,
          [s.portEnv]: port,
          [s.baseUrlEnv]: 'https://' + deployId + '.' + config.host
        }
      }
    })
    const additionalEnv = additionalData.reduce((a, v) => ({ ...a, ...v.env }), {})

    console.log(`RE-DEPLOY - ${deployId}: Starting application`)
    const [script, args] = config.startFile.split('--').map(s => s.trim())
    await execPM2('stop', name)
    await execPM2('start', {
      name,
      script,
      args,
      cwd: deployPath,
      env: {
        ...utils.prepareEnvs(config, currentPort),
        ...additionalEnv,
        PORT: currentPort,
        BASE_URL: 'https://' + deployId + '.' + config.host
      }
    })
    await redis.set(deployId, currentPort)
    for (const data of additionalData) {
      await redis.set(data.deployId, data.port)
    }

    console.log(`RE-DEPLOY - ${deployId}: Finished`)
    await updateStatus(deployId, RUNNING, cloneUrl, branch, sha)
    return Promise.resolve()
  } catch (e) {
    console.log(`${deployId}: Aborted`, e)
    return Promise.resolve()
  }
}

function execPM2 (fun, options) {
  return new Promise((resolve, reject) => {
    pm2[fun](options, err => {
      if (err) {
        reject(err)
        return
      }

      resolve()
    })
  })
}

function removeDeployment (deployId, config) {
  const statusId = deployId + '-STATUS'
  console.log(deployId + ': Removing deployment')

  const additionalServers = config.additionalServers || []
  const deployIds = [deployId, ...additionalServers.map(s => getDeploymentId(deployId, s))]

  return redis.del(...deployIds, statusId)
    .then(() => {
      return execPM2('delete', deployId)
        .catch(() => Promise.resolve())
    })
    .then(() => rmDirAsync(path.resolve('deploys', deployId), { recursive: true }))
    .then(() => console.log(deployId + ': Removed deployment'))
    .catch(e => {
      console.log(e.message)
      Promise.resolve()
    })
}

function getDeploymentId (deployId, addServer) {
  return deployId + (addServer ? '_' + addServer.subdomain : '')
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
  checkStatus,
  pushEvent
}
