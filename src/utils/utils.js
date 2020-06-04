const crypto = require('crypto')

function verifySignature (req, payloadBody, secret) {
  const receivedSignature = req.header('X-HUB-SIGNATURE')
  if (receivedSignature === undefined) {
    return false
  }

  const sha1 = crypto.createHmac('sha1', secret)
  sha1.update(payloadBody)

  const signature = 'sha1=' + sha1.digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(receivedSignature))
}

function getIdPrefix (config) {
  return config.name.replace(' ', '-').toLowerCase()
}

function getIdFromPullRequest (config, pullRequest) {
  return `${getIdPrefix(config)}-pr-${pullRequest.number}`
}

function getIdFromBranch (config, ref) {
  return `${getIdPrefix(config)}-branch-${ref.replace('refs/heads/')}`
}

function getIdFromTag (config, ref) {
  return `${getIdPrefix(config)}-tag-${ref.replace('refs/tags/')}`
}

function prepareEnvs (config, port) {
  const envs = {}
  for (const [key, env] of Object.entries(config.env)) {
    envs[key] = env.replace('{{PORT}}', port)
  }
  return envs
}

module.exports = {
  verifySignature,
  getIdFromPullRequest,
  getIdFromBranch,
  getIdFromTag,
  prepareEnvs
}
