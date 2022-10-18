const configs = require('../../config.json')

function getConfigForStatus (info) {
  const repository = info.cloneUrl.replace('https://github.com/', '').slice(0, -4) // Remove '.git'
  const branch = info.branch
  return getConfigForRepository(repository, branch)
}

function getConfigForPayload (eventType, payload) {
  const branch = getBranchFromPayload(eventType, payload)
  const repository = payload.repository.full_name
  return getConfigForRepository(repository, branch)
}

function getConfigForRepository (repository, branch) {
  const matchingConfigs = []
  for (const config of configs) {
    if (repository === config.repository) {
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
      branch,
      repository
    }))
  }

  if (matchingConfigs.length > 1) {
    console.warn('Multiple matching configs for: ' + JSON.stringify({
      branch,
      repository
    }) + ' selecting first found')
  }

  return matchingConfigs[0]
}

function getBranchFromPayload (eventType, payload) {
  switch (eventType) {
    case 'pull_request':
      return payload.pull_request.head.ref
    case 'check_run':
      return getCheckRunBranch(payload)
    case 'delete':
    case 'push':
      return payload.ref.replace('refs/heads/', '') // This will always return as "refs/heads/BRANCH"
  }
}

function getCheckRunBranch (payload) {
  if (payload.check_run.check_suite.head_branch === null) {
    return payload.repository.default_branch
  }
  return payload.check_run.check_suite.head_branch
}

module.exports = {
  getConfigForStatus,
  getConfigForPayload,
  getBranchFromPayload,
  getCheckRunBranch
}
