const express = require('express')
const crypto = require('crypto')

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'testing'
// const GITHUB_USERNAME = process.env.GITHUB_USERNAME
// const GITHUB_ACCESS_TOKEN = process.env.GITHUB_ACCESS_TOKEN
const PORT = process.env.PORT || 3000

const app = express()
app.disable('x-powered-by')
app.use(express.json())

app.use((req, res, next) => {
  if (verifySignature(req, JSON.stringify(req.body))) {
    next()
  } else {
    res.sendStatus(500)
  }
})

app.post('/', (req, res) => {
  res.sendStatus(200)
})

function verifySignature (req, payloadBody) {
  const receivedSignature = req.header('X-HUB-SIGNATURE')
  if (receivedSignature === undefined) {
    return false
  }

  const sha1 = crypto.createHmac('sha1', WEBHOOK_SECRET)
  sha1.update(payloadBody)

  const signature = 'sha1=' + sha1.digest('hex')
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(receivedSignature))
}

app.listen(PORT, () => console.log(`Listening to port ${PORT}`))
