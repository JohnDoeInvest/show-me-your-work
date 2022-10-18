const crypto = require('crypto')
const childProcess = require('child_process')

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
  return `${getIdPrefix(config)}-branch-${ref.replace('refs/heads/', '')}`
}

function getIdFromTag (config, ref) {
  return `${getIdPrefix(config)}-tag-${ref.replace('refs/tags/', '')}`
}

function prepareEnvs (config, port) {
  const envs = {}
  for (const [key, env] of Object.entries(config.env)) {
    envs[key] = env.replace('{{PORT}}', port)
  }
  return envs
}

function execAsync (command, options) {
  return new Promise(function (resolve, reject) {
    childProcess.exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(error)
        return
      }

      resolve()
    })
  })
}

module.exports = {
  verifySignature,
  getIdFromPullRequest,
  getIdFromBranch,
  getIdFromTag,
  prepareEnvs,
  execAsync
}
