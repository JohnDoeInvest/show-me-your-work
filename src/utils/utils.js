const crypto = require('crypto')
const net = require('net')

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

function getIdFromPullRequest (pullRequest) {
  return 'pr-' + pullRequest.number
}

function getIdFromBranch (ref) {
  return 'branch-' + ref.replace('refs/heads/')
}

function getIdFromTag (ref) {
  return 'tag-' + ref.replace('refs/tags/')
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
  getAvailablePort,
  verifySignature,
  getIdFromPullRequest,
  getIdFromBranch,
  getIdFromTag
}
